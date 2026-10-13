/**
 * ==========================================
 * GUEST ORDER RECOVERY + TOKEN EXPIRY — REAL DATABASE INTEGRATION
 * ==========================================
 *
 * These tests EXECUTE THE REAL CODE AGAINST THE REAL MariaDB
 * (database `toko`), like __tests__/p0/remediation.integration.test.ts
 * and __tests__/security/guest-limits-concurrency.integration.test.ts.
 *
 * A mocked Prisma client cannot prove the properties that actually
 * protect a guest order:
 *
 *   1. a two-phase challenge really is persisted with only KEYED HASHES
 *      (no raw OTP, no raw contact) and really is SINGLE USE under
 *      concurrency — the redemption is a conditional UPDATE, so the
 *      database decides the winner,
 *   2. phase 1 really does NOT touch the access token (the stored hash
 *      is byte-identical before and after a code request),
 *   3. the 30-day expiry really is written WITH the new hash on recovery
 *      and really is ENFORCED on read — including the fail-closed case
 *      of a token with NO recorded window,
 *   4. a delivery failure really does burn the challenge so nothing can
 *      redeem it, and
 *   5. the ORDER row is never deleted: historical orders survive an
 *      expired token and are recoverable.
 *
 * Only the WhatsApp provider is mocked (no real message is ever sent).
 * Every row is created with a unique suffix and removed in afterAll.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
    RECOVERY_CODE_TTL_MS,
    confirmGuestRecovery,
    startGuestRecovery,
} from "@/lib/guest-recovery";
import {
    resolveOrderAccess,
} from "@/lib/guest-order-access";
import {
    GUEST_ACCESS_TOKEN_TTL_MS,
    buildGuestIdentityKey,
    guestAccessTokenExpiry,
    hashGuestAccessToken,
    isGuestTokenValid,
} from "@/lib/guest-identity";

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "guest-recovery-integration-secret";

jest.setTimeout(60000);

/* ==========================================
 * PROVIDER + IMPORT CHAIN (no network, no auth session)
 * ========================================== */

const mockSendRawNotificationNow = jest.fn();

jest.mock("@/lib/notification/order-status-handler", () => ({
    sendRawNotificationNow: (input: unknown) =>
        mockSendRawNotificationNow(input),
}));

jest.mock("@/auth", () => ({ auth: jest.fn(async () => null) }));

jest.mock("next/headers", () => ({
    cookies: jest.fn(async () => ({
        get: () => undefined,
        getAll: () => [],
    })),
}));

const SUFFIX = `gri-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const EMAIL = `${SUFFIX}@gtest.local`;
const PHONE = "081200000123";

const createdOrderIds: number[] = [];

function otpFromRawMessage(rawMessage: string): string {
    const match = /Kode: \*(\d{6})\*/.exec(rawMessage);

    if (!match) {
        throw new Error(`OTP missing from message: ${rawMessage}`);
    }

    return match[1];
}

async function seedGuestOrder(options: {
    withToken?: boolean;
    expiresAt?: Date | null;
    withReview?: boolean;
}) {
    /*
     * `guestAccessTokenHash` is UNIQUE, so every seeded order gets its
     * own token — which also makes each test's token unambiguous.
     */
    const originalToken = `original-token-${SUFFIX}-${createdOrderIds.length}`;

    const order = await prisma.order.create({
        data: {
            orderNumber: `IT-REC-${SUFFIX}-${createdOrderIds.length}`,
            recipientName: "IT Guest",
            phone: PHONE,
            address: "Jl. Integration No. 1",
            subtotal: new Prisma.Decimal(100_000),
            shippingCost: new Prisma.Decimal(20_000),
            total: new Prisma.Decimal(120_000),
            status: "PENDING",
            paymentMethod: "COD",
            paymentStatus: "UNPAID",
            customerEmail: EMAIL,
            guestIdentityKey: buildGuestIdentityKey({
                email: EMAIL,
                phone: PHONE,
            }),
            guestAccessTokenHash:
                options.withToken === false
                    ? null
                    : hashGuestAccessToken(originalToken),
            guestAccessTokenExpiresAt:
                options.withToken === false
                    ? null
                    : (options.expiresAt === undefined
                          ? guestAccessTokenExpiry()
                          : options.expiresAt),
            requiresCodReview: Boolean(options.withReview),
            codReviewStatus: options.withReview
                ? "PENDING"
                : null,
        },
    });

    createdOrderIds.push(order.id);

    return { ...order, rawToken: originalToken };
}

afterAll(async () => {
    if (createdOrderIds.length > 0) {
        // Challenges cascade from the order; order items too.
        await prisma.order.deleteMany({
            where: { id: { in: createdOrderIds } },
        });
    }

    await prisma.$disconnect();
});

beforeEach(() => {
    jest.clearAllMocks();
    mockSendRawNotificationNow.mockResolvedValue({
        success: true,
        notificationId: 1,
    });
});

/* ==========================================
 * EXPIRY ENFORCEMENT (real rows)
 * ========================================== */

describe("guest token expiry against the real database", () => {
    test("a live token opens the order and an expired one is refused", async () => {
        const order = await seedGuestOrder({});

        await expect(
            resolveOrderAccess({
                orderId: order.id,
                rawToken: order.rawToken,
            })
        ).resolves.toEqual({ ok: true, via: "TOKEN" });

        // The window is really persisted as 30 days from issuance.
        const stored = await prisma.order.findUnique({
            where: { id: order.id },
            select: { guestAccessTokenExpiresAt: true },
        });

        expect(
            stored!.guestAccessTokenExpiresAt
        ).not.toBeNull();
        expect(
            stored!.guestAccessTokenExpiresAt!.getTime() -
                Date.now()
        ).toBeGreaterThan(
            GUEST_ACCESS_TOKEN_TTL_MS - 120_000
        );

        // Expire it in the database, exactly as time would.
        await prisma.order.update({
            where: { id: order.id },
            data: {
                guestAccessTokenExpiresAt: new Date(
                    Date.now() - 1000
                ),
            },
        });

        await expect(
            resolveOrderAccess({
                orderId: order.id,
                rawToken: order.rawToken,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "EXPIRED",
        });

        // The order is PRESERVED, not deleted or hidden.
        const stillThere = await prisma.order.findUnique({
            where: { id: order.id },
            select: { id: true, orderNumber: true },
        });

        expect(stillThere?.id).toBe(order.id);
    });

    test("a token with NO recorded window fails closed (legacy row)", async () => {
        const order = await seedGuestOrder({
            expiresAt: null,
        });

        await expect(
            resolveOrderAccess({
                orderId: order.id,
                rawToken: order.rawToken,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "EXPIRED",
        });

        // …but the buyer is not locked out: the recovery flow below can
        // issue a fresh token for this very row.
        expect(isGuestTokenValid(null)).toBe(false);
    });

    test("the migration is additive and the column is nullable", async () => {
        const columns = await prisma.$queryRawUnsafe<
            { IS_NULLABLE: string; DATA_TYPE: string }[]
        >(
            "SELECT IS_NULLABLE, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order' AND COLUMN_NAME = 'guestAccessTokenExpiresAt'"
        );

        expect(columns).toHaveLength(1);
        expect(columns[0].IS_NULLABLE).toBe("YES");

        const challengeColumns =
            await prisma.$queryRawUnsafe<{ TABLE_NAME: string }[]>(
                "SHOW TABLES LIKE 'guestrecoverychallenge'"
            );

        expect(challengeColumns).toHaveLength(1);
    });
});

/* ==========================================
 * TWO-PHASE RECOVERY (real challenge rows)
 * ========================================== */

describe("two-phase recovery against the real database", () => {
    test("phase 1 sends a code, persists only hashes and rotates NOTHING", async () => {
        const order = await seedGuestOrder({});
        const before = await prisma.order.findUnique({
            where: { id: order.id },
            select: {
                guestAccessTokenHash: true,
                guestAccessTokenExpiresAt: true,
            },
        });

        const result = await startGuestRecovery({
            orderNumber: order.orderNumber,
            email: EMAIL,
        });

        expect(result.ok).toBe(true);

        const challengeId = (
            result as { challengeId: string }
        ).challengeId;

        const challenge =
            await prisma.guestRecoveryChallenge.findUnique({
                where: { id: challengeId },
            });

        expect(challenge).not.toBeNull();

        const rawCode = otpFromRawMessage(
            mockSendRawNotificationNow.mock.calls[0][0]
                .rawMessage
        );

        // Only keyed hashes are stored.
        expect(challenge!.codeHash).not.toContain(rawCode);
        expect(challenge!.codeHash).toHaveLength(64);
        expect(challenge!.deliveredAt).not.toBeNull();
        expect(challenge!.consumedAt).toBeNull();
        expect(challenge!.attempts).toBe(0);

        // Short-lived.
        expect(
            challenge!.expiresAt.getTime() - Date.now()
        ).toBeLessThanOrEqual(RECOVERY_CODE_TTL_MS);

        // THE invariant: nothing about the access token changed.
        const after = await prisma.order.findUnique({
            where: { id: order.id },
            select: {
                guestAccessTokenHash: true,
                guestAccessTokenExpiresAt: true,
            },
        });

        expect(after!.guestAccessTokenHash).toBe(
            before!.guestAccessTokenHash
        );
        expect(
            after!.guestAccessTokenExpiresAt!.getTime()
        ).toBe(
            before!.guestAccessTokenExpiresAt!.getTime()
        );
    });

    test("a wrong code costs an attempt and a right one mints exactly one token", async () => {
        const order = await seedGuestOrder({});

        const started = await startGuestRecovery({
            orderNumber: order.orderNumber,
            email: EMAIL,
        });

        expect(started.ok).toBe(true);

        const challengeId = (
            started as { challengeId: string }
        ).challengeId;
        const rawCode = otpFromRawMessage(
            mockSendRawNotificationNow.mock.calls[0][0]
                .rawMessage
        );

        // Wrong code: no token, attempt recorded.
        await expect(
            confirmGuestRecovery({
                challengeId,
                code:
                    rawCode === "000000"
                        ? "111111"
                        : "000000",
                email: EMAIL,
            })
        ).resolves.toEqual({ ok: false, reason: "INVALID" });

        const afterWrong =
            await prisma.guestRecoveryChallenge.findUnique({
                where: { id: challengeId },
                select: { attempts: true, consumedAt: true },
            });

        expect(afterWrong!.attempts).toBe(1);
        expect(afterWrong!.consumedAt).toBeNull();

        const orderBefore = await prisma.order.findUnique({
            where: { id: order.id },
            select: { guestAccessTokenHash: true },
        });

        expect(orderBefore!.guestAccessTokenHash).toBe(
            hashGuestAccessToken(order.rawToken)
        );

        // Right code: token minted, hash replaced, window rewritten.
        const confirmed = await confirmGuestRecovery({
            challengeId,
            code: rawCode,
            email: EMAIL,
        });

        expect(confirmed.ok).toBe(true);

        const rawToken = (confirmed as { token: string }).token;

        expect(rawToken).not.toBe(order.rawToken);

        const orderAfter = await prisma.order.findUnique({
            where: { id: order.id },
            select: {
                guestAccessTokenHash: true,
                guestAccessTokenExpiresAt: true,
            },
        });

        expect(orderAfter!.guestAccessTokenHash).toBe(
            hashGuestAccessToken(rawToken)
        );
        expect(
            orderAfter!.guestAccessTokenExpiresAt!.getTime() -
                Date.now()
        ).toBeGreaterThan(
            GUEST_ACCESS_TOKEN_TTL_MS - 120_000
        );

        // The RAW token is nowhere in the database.
        const leaked = await prisma.$queryRawUnsafe<
            { n: bigint }[]
        >(
            "SELECT COUNT(*) AS n FROM `order` WHERE guestAccessTokenHash = ?",
            rawToken
        );

        expect(Number(leaked[0].n)).toBe(0);

        // The new token opens the order; the old one does not.
        await expect(
            resolveOrderAccess({
                orderId: order.id,
                rawToken,
            })
        ).resolves.toEqual({ ok: true, via: "TOKEN" });

        await expect(
            resolveOrderAccess({
                orderId: order.id,
                rawToken: order.rawToken,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });

        // Single use: the same code can never mint a second token.
        await expect(
            confirmGuestRecovery({
                challengeId,
                code: rawCode,
                email: EMAIL,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });

        const finalOrder = await prisma.order.findUnique({
            where: { id: order.id },
            select: { guestAccessTokenHash: true },
        });

        expect(finalOrder!.guestAccessTokenHash).toBe(
            hashGuestAccessToken(rawToken)
        );
    });

    test("two parallel confirmations mint at most ONE token", async () => {
        const order = await seedGuestOrder({});

        const started = await startGuestRecovery({
            orderNumber: order.orderNumber,
            email: EMAIL,
        });

        const challengeId = (
            started as { challengeId: string }
        ).challengeId;
        const rawCode = otpFromRawMessage(
            mockSendRawNotificationNow.mock.calls[0][0]
                .rawMessage
        );

        const [first, second] = await Promise.all([
            confirmGuestRecovery({
                challengeId,
                code: rawCode,
                email: EMAIL,
            }),
            confirmGuestRecovery({
                challengeId,
                code: rawCode,
                email: EMAIL,
            }),
        ]);

        const winners = [first, second].filter(
            (result) => result.ok
        );

        expect(winners).toHaveLength(1);

        const winnerToken = (
            winners[0] as unknown as { token: string }
        ).token;

        const orderAfter = await prisma.order.findUnique({
            where: { id: order.id },
            select: { guestAccessTokenHash: true },
        });

        // The stored hash belongs to the WINNER's token — the loser
        // could not overwrite it (and could not hand the buyer a token
        // that does not match the row).
        expect(orderAfter!.guestAccessTokenHash).toBe(
            hashGuestAccessToken(winnerToken)
        );
    });

    test("a re-request supersedes the outstanding challenge", async () => {
        const order = await seedGuestOrder({});

        const first = await startGuestRecovery({
            orderNumber: order.orderNumber,
            email: EMAIL,
        });
        const firstId = (first as { challengeId: string })
            .challengeId;

        const second = await startGuestRecovery({
            orderNumber: order.orderNumber,
            email: EMAIL,
        });
        const secondId = (second as { challengeId: string })
            .challengeId;

        const superseded =
            await prisma.guestRecoveryChallenge.findUnique({
                where: { id: firstId },
                select: { consumedAt: true, deliveryError: true },
            });

        expect(superseded!.consumedAt).not.toBeNull();
        expect(superseded!.deliveryError).toContain(
            "permintaan kode verifikasi baru"
        );

        const live =
            await prisma.guestRecoveryChallenge.findUnique({
                where: { id: secondId },
                select: { consumedAt: true },
            });

        expect(live!.consumedAt).toBeNull();
    });

    test("a delivery failure burns the challenge and mints nothing", async () => {
        const order = await seedGuestOrder({});
        const before = await prisma.order.findUnique({
            where: { id: order.id },
            select: { guestAccessTokenHash: true },
        });

        mockSendRawNotificationNow.mockResolvedValue({
            success: false,
            errorCode: "PROVIDER_NOT_CONFIGURED",
        });

        await expect(
            startGuestRecovery({
                orderNumber: order.orderNumber,
                email: EMAIL,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "DELIVERY_FAILED",
        });

        const burned =
            await prisma.guestRecoveryChallenge.findMany({
                where: { orderId: order.id },
                select: {
                    consumedAt: true,
                    deliveredAt: true,
                    deliveryError: true,
                },
            });

        expect(burned).toHaveLength(1);
        expect(burned[0].consumedAt).not.toBeNull();
        expect(burned[0].deliveredAt).toBeNull();
        expect(burned[0].deliveryError).toBe(
            "PROVIDER_NOT_CONFIGURED"
        );

        const after = await prisma.order.findUnique({
            where: { id: order.id },
            select: { guestAccessTokenHash: true },
        });

        expect(after!.guestAccessTokenHash).toBe(
            before!.guestAccessTokenHash
        );
    });

    test("an undelivered challenge can never be redeemed", async () => {
        const order = await seedGuestOrder({});

        const started = await startGuestRecovery({
            orderNumber: order.orderNumber,
            email: EMAIL,
        });

        const challengeId = (
            started as { challengeId: string }
        ).challengeId;
        const rawCode = otpFromRawMessage(
            mockSendRawNotificationNow.mock.calls[0][0]
                .rawMessage
        );

        // Simulate the crash-between-delivery-and-stamp case.
        await prisma.guestRecoveryChallenge.update({
            where: { id: challengeId },
            data: { deliveredAt: null },
        });

        await expect(
            confirmGuestRecovery({
                challengeId,
                code: rawCode,
                email: EMAIL,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });

        const orderAfter = await prisma.order.findUnique({
            where: { id: order.id },
            select: { guestAccessTokenHash: true },
        });

        expect(orderAfter!.guestAccessTokenHash).toBe(
            hashGuestAccessToken(order.rawToken)
        );
    });
});
