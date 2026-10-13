/**
 * ==========================================
 * GUEST ORDER RECOVERY (TWO-PHASE OTP) — UNIT TESTS
 * ==========================================
 *
 * The storefront is 100% guest-based for customers, so a buyer has no
 * account to fall back on: their order is reachable through the
 * httpOnly access-token cookie issued at checkout. This suite pins the
 * recovery path for the two cases that cookie cannot cover — a lost
 * cookie, and an EXPIRED token.
 *
 * PINNED PROPERTIES
 * -----------------
 *   1. Phase 1 (request) NEVER rotates or reveals an access token: it
 *      can only cause a one-time code to be sent to the phone number
 *      recorded on the order.
 *   2. The code is delivered through the EXISTING WhatsApp pipeline,
 *      synchronously, and a delivery failure FAILS CLOSED — the
 *      challenge is burned and no token can ever be minted.
 *   3. The challenge is bound to the order AND to the checkout contact
 *      proven in phase 1; phase 2 must re-present that same contact.
 *   4. The code is SINGLE USE (a replay yields at most one token),
 *      SHORT LIVED and ATTEMPT LIMITED.
 *   5. A token is minted only after the OTP verifies, and only the
 *      hash + the 30-day window are persisted; the raw token travels
 *      exclusively in an httpOnly cookie.
 *   6. No raw OTP, raw contact or raw token ever appears in a response
 *      body.
 *
 * Prisma, auth and the notification provider are mocked: no database,
 * no WhatsApp message and no payment provider is touched.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "guest-recovery-otp-test-secret";

/* A trusted proxy is configured so every request can be given a UNIQUE
 * client IP — the recovery limiters are real (in-memory), and without a
 * per-test bucket the later tests in this file would see 429 from the
 * budget the earlier ones consumed. */
process.env.TRUSTED_PROXY = "1";

jest.mock("@/auth", () => ({ auth: jest.fn(async () => null) }));

jest.mock("next/headers", () => ({
    cookies: jest.fn(async () => ({
        get: () => undefined,
        getAll: () => [],
    })),
}));

const mockOrder = {
    findUnique: jest.fn(),
    update: jest.fn(),
};

const mockChallenge = {
    findUnique: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
};

const mockTx = {
    guestRecoveryChallenge: mockChallenge,
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
        guestRecoveryChallenge: mockChallenge,
        $transaction: jest.fn(
            async (
                fn: (tx: unknown) => Promise<unknown>
            ) => fn(mockTx)
        ),
    },
}));

const mockSendRawNotificationNow = jest.fn();

jest.mock("@/lib/notification/order-status-handler", () => ({
    sendRawNotificationNow: (
        input: unknown
    ) => mockSendRawNotificationNow(input),
}));

import { prisma } from "@/lib/prisma";

import {
    RECOVERY_CODE_MAX_ATTEMPTS,
    RECOVERY_CODE_TTL_MS,
    confirmGuestRecovery,
    startGuestRecovery,
} from "@/lib/guest-recovery";
import {
    GUEST_ORDER_COOKIE_PREFIX,
    GUEST_ACCESS_TOKEN_TTL_MS,
    hashContact,
    hashRecoveryCode,
    hashGuestAccessToken,
} from "@/lib/guest-identity";

import { POST as recoverPOST } from "@/app/api/orders/recover/route";
import { POST as confirmPOST } from "@/app/api/orders/recover/confirm/route";

const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
    update: jest.Mock;
};
const mockedChallenge = prisma
    .guestRecoveryChallenge as unknown as {
    findUnique: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
};

const ORDER_ID = 4242;

/**
 * The contact a phase-2 challenge is BOUND to; every confirmation test
 * must re-present exactly this value (that binding is what makes a
 * stolen/guessed code insufficient on its own).
 */
const CONTACT = {
    email: "recover-buyer@example.com",
    phone: "081234567890",
};

let ipCounter = 0;
let contactCounter = 0;

function nextIp(): string {
    ipCounter += 1;
    return `203.0.113.${ipCounter}`;
}

/** A unique contact per test, so the real per-identity limiter is not shared. */
function nextContact() {
    contactCounter += 1;
    const suffix = `${Date.now()}-${contactCounter}`;

    return {
        email: `buyer-${suffix}@example.com`,
        phone: `0812${String(contactCounter).padStart(4, "0")}${String(
            Date.now() % 100000
        ).padStart(5, "0")}`,
    };
}

function orderFixture(
    contact: { email: string; phone: string },
    overrides: Record<string, unknown> = {}
) {
    return {
        id: ORDER_ID,
        userId: null,
        orderNumber: "PAY-CART-4242",
        customerEmail: contact.email,
        phone: contact.phone,
        guestAccessTokenHash: hashGuestAccessToken("old-token"),
        ...overrides,
    };
}

/** Phase-1 challenge row as persisted by startGuestRecovery. */
function challengeFixture(overrides: Record<string, unknown> = {}) {
    return {
        id: "challenge-1",
        orderId: ORDER_ID,
        orderNumber: "PAY-CART-4242",
        channel: "whatsapp",
        contactChannel: "email",
        contactHash: hashContact(CONTACT.email),
        codeHash: hashRecoveryCode("challenge-1", "123456"),
        attempts: 0,
        maxAttempts: RECOVERY_CODE_MAX_ATTEMPTS,
        deliveredAt: new Date(),
        deliveryError: null,
        consumedAt: null,
        expiresAt: new Date(Date.now() + RECOVERY_CODE_TTL_MS),
        notificationId: 7,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

function jsonRequest(
    url: string,
    body: unknown,
    ip: string
): Request {
    return new Request(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-forwarded-for": ip,
        },
        body: JSON.stringify(body),
    });
}

/** Pull the OTP out of the WhatsApp body the flow handed to the provider. */
function otpFromRawMessage(rawMessage: string): string {
    const match = /Kode: \*(\d{6})\*/.exec(rawMessage);

    if (!match) {
        throw new Error(
            `OTP not found in message: ${rawMessage}`
        );
    }

    return match[1];
}

beforeEach(() => {
    jest.clearAllMocks();

    mockedOrder.update.mockResolvedValue({});
    mockedChallenge.updateMany.mockResolvedValue({ count: 1 });
    mockSendRawNotificationNow.mockResolvedValue({
        success: true,
        notificationId: 7,
    });
});

/* ==========================================
 * PHASE 1 — REQUEST
 * ========================================== */

describe("startGuestRecovery (phase 1)", () => {
    test("sends a 6-digit code and NEVER rotates the access token", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        const result = await startGuestRecovery({
            orderNumber: "PAY-CART-4242",
            email: contact.email,
        });

        expect(result).toMatchObject({
            ok: true,
            challengeId: expect.any(String),
        });

        // THE core invariant: knowledge of order number + contact is
        // not ownership, so no token is minted, rotated or revealed.
        expect(mockedOrder.update).not.toHaveBeenCalled();

        expect(
            mockSendRawNotificationNow
        ).toHaveBeenCalledTimes(1);

        const notification =
            mockSendRawNotificationNow.mock.calls[0][0];

        expect(notification.notificationType).toBe(
            "GUEST_RECOVERY_OTP"
        );
        expect(notification.channel).toBe("whatsapp");
        expect(notification.idempotencyKey).toContain(
            (result as { challengeId: string }).challengeId
        );

        // The code is delivered to the phone RECORDED ON THE ORDER,
        // never to a caller-supplied destination.
        expect(notification.recipient).toBe(
            "62" + contact.phone.slice(1)
        );
    });

    test("stores only keyed hashes — never the raw code or contact", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        const result = await startGuestRecovery({
            orderNumber: "PAY-CART-4242",
            phone: contact.phone,
        });

        expect(result.ok).toBe(true);

        const created = mockedChallenge.create.mock.calls[0][0]
            .data;
        const rawCode = otpFromRawMessage(
            mockSendRawNotificationNow.mock.calls[0][0]
                .rawMessage
        );

        expect(rawCode).toMatch(/^\d{6}$/);
        expect(created.codeHash).toBe(
            hashRecoveryCode(created.id, rawCode)
        );
        expect(JSON.stringify(created)).not.toContain(rawCode);
        expect(JSON.stringify(created)).not.toContain(
            contact.email
        );
        expect(JSON.stringify(created)).not.toContain(
            contact.phone
        );

        // Attempt-limited + short-lived.
        expect(created.maxAttempts).toBe(
            RECOVERY_CODE_MAX_ATTEMPTS
        );
        expect(
            created.expiresAt.getTime() - Date.now()
        ).toBeLessThanOrEqual(RECOVERY_CODE_TTL_MS);
    });

    test("a re-request invalidates every outstanding challenge for the order", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        await startGuestRecovery({
            orderNumber: "PAY-CART-4242",
            email: contact.email,
        });

        expect(mockedChallenge.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    orderId: ORDER_ID,
                    consumedAt: null,
                },
                data: expect.objectContaining({
                    consumedAt: expect.any(Date),
                }),
            })
        );
    });

    test("a contact mismatch is NOT_FOUND and sends nothing", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        await expect(
            startGuestRecovery({
                orderNumber: "PAY-CART-4242",
                email: "attacker@example.com",
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });

        expect(mockedChallenge.create).not.toHaveBeenCalled();
        expect(
            mockSendRawNotificationNow
        ).not.toHaveBeenCalled();
        expect(mockedOrder.update).not.toHaveBeenCalled();
    });

    test("an account-owned order is refused — the session is the stronger factor", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact, { userId: "user-1" })
        );

        await expect(
            startGuestRecovery({
                orderNumber: "PAY-CART-4242",
                email: contact.email,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "ACCOUNT_ORDER",
        });

        expect(mockedOrder.update).not.toHaveBeenCalled();
    });

    test("an order with no usable delivery phone fails closed", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact, { phone: "not-a-phone" })
        );

        await expect(
            startGuestRecovery({
                orderNumber: "PAY-CART-4242",
                email: contact.email,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "DELIVERY_FAILED",
        });

        expect(mockedChallenge.create).not.toHaveBeenCalled();
    });

    test("a provider failure BURNS the challenge and never mints a token", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );
        mockSendRawNotificationNow.mockResolvedValue({
            success: false,
            errorCode: "PROVIDER_NOT_CONFIGURED",
        });

        const result = await startGuestRecovery({
            orderNumber: "PAY-CART-4242",
            email: contact.email,
        });

        expect(result).toEqual({
            ok: false,
            reason: "DELIVERY_FAILED",
        });

        // The fail-closed burn: consumed + the provider's reason.
        expect(mockedChallenge.updateMany).toHaveBeenCalledWith({
            where: { id: expect.any(String) },
            data: expect.objectContaining({
                consumedAt: expect.any(Date),
                deliveryError: "PROVIDER_NOT_CONFIGURED",
            }),
        });

        expect(mockedOrder.update).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * PHASE 2 — CONFIRM
 * ========================================== */

describe("confirmGuestRecovery (phase 2)", () => {
    test("a verified code mints exactly one token and persists its window", async () => {
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture()
        );
        mockedOrder.findUnique.mockResolvedValue({
            id: ORDER_ID,
            orderNumber: "PAY-CART-4242",
            userId: null,
        });

        const result = await confirmGuestRecovery({
            challengeId: "challenge-1",
            code: "123456",
            email: CONTACT.email,
        });

        expect(result.ok).toBe(true);

        const persisted = mockedOrder.update.mock.calls[0][0];
        const rawToken = (result as { token: string }).token;

        expect(persisted.data.guestAccessTokenHash).toBe(
            hashGuestAccessToken(rawToken)
        );
        expect(
            persisted.data.guestAccessTokenExpiresAt.getTime() -
                Date.now()
        ).toBeGreaterThan(
            GUEST_ACCESS_TOKEN_TTL_MS - 60_000
        );

        // Single-use redemption.
        expect(mockedChallenge.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "challenge-1", consumedAt: null },
                data: { consumedAt: expect.any(Date) },
            })
        );
    });

    test("a WRONG code never touches the access token", async () => {
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture()
        );

        await expect(
            confirmGuestRecovery({
                challengeId: "challenge-1",
                code: "000000",
                email: CONTACT.email,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "INVALID",
        });

        expect(mockedOrder.update).not.toHaveBeenCalled();
    });

    test("the attempt budget is consumed BEFORE the comparison", async () => {
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture()
        );

        await confirmGuestRecovery({
            challengeId: "challenge-1",
            code: "000000",
            email: CONTACT.email,
        });

        expect(mockedChallenge.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: "challenge-1",
                    consumedAt: null,
                    attempts: {
                        lt: RECOVERY_CODE_MAX_ATTEMPTS,
                    },
                }),
                data: {
                    attempts: { increment: 1 },
                },
            })
        );
    });

    test("the last wrong attempt burns the challenge", async () => {
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture({
                attempts: RECOVERY_CODE_MAX_ATTEMPTS - 1,
            })
        );

        await expect(
            confirmGuestRecovery({
                challengeId: "challenge-1",
                code: "000000",
                email: CONTACT.email,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "EXHAUSTED",
        });

        expect(mockedChallenge.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "challenge-1" },
                data: expect.objectContaining({
                    attempts: RECOVERY_CODE_MAX_ATTEMPTS,
                    consumedAt: expect.any(Date),
                }),
            })
        );

        expect(mockedOrder.update).not.toHaveBeenCalled();
    });

    test("a replayed code cannot mint a second token", async () => {
        // The row was already redeemed by the first confirmation.
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture({ consumedAt: new Date() })
        );

        await expect(
            confirmGuestRecovery({
                challengeId: "challenge-1",
                code: "123456",
                email: CONTACT.email,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });

        expect(mockedOrder.update).not.toHaveBeenCalled();
    });

    test("losing the redemption race mints nothing", async () => {
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture()
        );

        // Attempt increment wins, the redemption CAS loses.
        mockedChallenge.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });

        await expect(
            confirmGuestRecovery({
                challengeId: "challenge-1",
                code: "123456",
                email: CONTACT.email,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });

        expect(mockedOrder.update).not.toHaveBeenCalled();
    });

    test("the SAME contact must be re-presented (binding)", async () => {
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture()
        );

        await expect(
            confirmGuestRecovery({
                challengeId: "challenge-1",
                code: "123456",
                email: "someone-else@example.com",
            })
        ).resolves.toEqual({
            ok: false,
            reason: "INVALID",
        });

        expect(mockedOrder.update).not.toHaveBeenCalled();
    });

    test("an expired challenge does not mint a token", async () => {
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture({
                expiresAt: new Date(Date.now() - 1000),
            })
        );

        await expect(
            confirmGuestRecovery({
                challengeId: "challenge-1",
                code: "123456",
                email: CONTACT.email,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "EXPIRED",
        });

        expect(mockedOrder.update).not.toHaveBeenCalled();
    });

    test("an UNDELIVERED challenge is never usable (fail closed)", async () => {
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture({ deliveredAt: null })
        );

        await expect(
            confirmGuestRecovery({
                challengeId: "challenge-1",
                code: "123456",
                email: CONTACT.email,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });

        expect(mockedOrder.update).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * HTTP CONTRACT
 * ========================================== */

describe("POST /api/orders/recover (HTTP contract)", () => {
    test("a matching second factor returns a challenge id and NO token", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        const response = await recoverPOST(
            jsonRequest(
                "http://test/api/orders/recover",
                {
                    orderNumber: "PAY-CART-4242",
                    email: contact.email,
                },
                nextIp()
            )
        );
        const body = await response.json();
        const serialized = JSON.stringify(body);

        expect(response.status).toBe(200);
        expect(body.data.challengeId).toEqual(
            expect.any(String)
        );
        expect(body.data.expiresInSeconds).toBeGreaterThan(0);

        // No token is issued, rotated or revealed at this stage.
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(serialized).not.toContain(contact.email);
        expect(serialized).not.toContain(contact.phone);

        const rawCode = otpFromRawMessage(
            mockSendRawNotificationNow.mock.calls[0][0]
                .rawMessage
        );
        expect(serialized).not.toContain(rawCode);
    });

    test("a mismatch is a uniform 404 (no existence oracle)", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        const response = await recoverPOST(
            jsonRequest(
                "http://test/api/orders/recover",
                {
                    orderNumber: "PAY-CART-4242",
                    email: "attacker@example.com",
                },
                nextIp()
            )
        );

        expect(response.status).toBe(404);
        expect(mockedOrder.update).not.toHaveBeenCalled();
    });

    test("an account-owned order answers 409 requiresLogin", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact, { userId: "user-1" })
        );

        const response = await recoverPOST(
            jsonRequest(
                "http://test/api/orders/recover",
                {
                    orderNumber: "PAY-CART-4242",
                    email: contact.email,
                },
                nextIp()
            )
        );
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.requiresLogin).toBe(true);
    });

    test("a delivery failure answers 502 (fail closed)", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );
        mockSendRawNotificationNow.mockResolvedValue({
            success: false,
            errorCode: "DELIVERY_FAILED",
        });

        const response = await recoverPOST(
            jsonRequest(
                "http://test/api/orders/recover",
                {
                    orderNumber: "PAY-CART-4242",
                    email: contact.email,
                },
                nextIp()
            )
        );

        expect(response.status).toBe(502);
        expect(response.headers.get("set-cookie")).toBeNull();
    });

    test("an invalid body is rejected before any lookup", async () => {
        const response = await recoverPOST(
            jsonRequest(
                "http://test/api/orders/recover",
                { orderNumber: "PAY-CART-4242" },
                nextIp()
            )
        );

        expect(response.status).toBe(400);
        expect(mockedOrder.findUnique).not.toHaveBeenCalled();
        expect(
            mockSendRawNotificationNow
        ).not.toHaveBeenCalled();
    });

    test("phase 1 is rate limited per IP", async () => {
        const ip = nextIp();

        // Exhaust the real per-IP budget (5 / 15 min).
        for (let i = 0; i < 5; i += 1) {
            const contact = nextContact();
            mockedOrder.findUnique.mockResolvedValue(
                orderFixture(contact)
            );

            await recoverPOST(
                jsonRequest(
                    "http://test/api/orders/recover",
                    {
                        orderNumber: "PAY-CART-4242",
                        email: contact.email,
                    },
                    ip
                )
            );
        }

        const blocked = await recoverPOST(
            jsonRequest(
                "http://test/api/orders/recover",
                {
                    orderNumber: "PAY-CART-4242",
                    email: nextContact().email,
                },
                ip
            )
        );

        expect(blocked.status).toBe(429);
    });
});

describe("POST /api/orders/recover/confirm (HTTP contract)", () => {
    test("a verified code sets an httpOnly cookie and never echoes the token", async () => {
        const contact = nextContact();
        const order = orderFixture(contact);

        // Phase 1 through the real route, so the challenge is bound to
        // the same contact the confirmation presents.
        mockedOrder.findUnique.mockResolvedValue(order);
        mockedChallenge.create.mockImplementation(
            async ({ data }: { data: Record<string, unknown> }) => ({
                ...challengeFixture(),
                ...data,
            })
        );

        const startResponse = await recoverPOST(
            jsonRequest(
                "http://test/api/orders/recover",
                {
                    orderNumber: "PAY-CART-4242",
                    email: contact.email,
                },
                nextIp()
            )
        );

        expect(startResponse.status).toBe(200);

        const created = mockedChallenge.create.mock.calls[0][0]
            .data;
        const rawCode = otpFromRawMessage(
            mockSendRawNotificationNow.mock.calls[0][0]
                .rawMessage
        );

        mockedOrder.findUnique.mockResolvedValue({
            id: ORDER_ID,
            orderNumber: "PAY-CART-4242",
            userId: null,
        });
        mockedChallenge.findUnique.mockResolvedValue({
            ...challengeFixture(),
            ...created,
            id: created.id,
            deliveredAt: new Date(),
            consumedAt: null,
        });

        const response = await confirmPOST(
            jsonRequest(
                "http://test/api/orders/recover/confirm",
                {
                    challengeId: created.id as string,
                    code: rawCode,
                    email: contact.email,
                },
                nextIp()
            )
        );
        const body = await response.json();
        const serialized = JSON.stringify(body);

        expect(response.status).toBe(200);
        expect(body.data.orderNumber).toBe("PAY-CART-4242");

        const setCookie =
            response.headers.get("set-cookie") ?? "";

        expect(setCookie).toContain(
            `${GUEST_ORDER_COOKIE_PREFIX}${ORDER_ID}=`
        );
        expect(setCookie.toLowerCase()).toContain("httponly");

        // Only the HASH is persisted; the raw token lives in the cookie.
        const match = new RegExp(
            `${GUEST_ORDER_COOKIE_PREFIX}${ORDER_ID}=(\\d+)\\.([A-Za-z0-9_-]+)`
        ).exec(setCookie);

        expect(match).not.toBeNull();

        const rawToken = match![2];

        expect(match![1]).toBe(String(ORDER_ID));
        expect(rawToken.length).toBeGreaterThan(20);
        expect(
            mockedOrder.update.mock.calls[0][0].data
                .guestAccessTokenHash
        ).toBe(hashGuestAccessToken(rawToken));

        // The secret travels ONLY in the cookie.
        expect(serialized).not.toContain(rawCode);
        expect(serialized).not.toContain(rawToken);
        expect(serialized).not.toContain("guestAccessTokenHash");
        expect(mockedOrder.update).toHaveBeenCalledTimes(1);
    });

    test("a malformed code is rejected before any lookup", async () => {
        const response = await confirmPOST(
            jsonRequest(
                "http://test/api/orders/recover/confirm",
                { challengeId: "challenge-1", code: "12ab" },
                nextIp()
            )
        );

        expect(response.status).toBe(400);
        expect(mockedChallenge.findUnique).not.toHaveBeenCalled();
    });

    test("a wrong code answers 400 and issues no cookie", async () => {
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture()
        );

        const response = await confirmPOST(
            jsonRequest(
                "http://test/api/orders/recover/confirm",
                {
                    challengeId: "challenge-1",
                    code: "000000",
                    email: CONTACT.email,
                },
                nextIp()
            )
        );

        expect(response.status).toBe(400);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(mockedOrder.update).not.toHaveBeenCalled();
    });

    test("an exhausted challenge answers 429", async () => {
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture({
                attempts: RECOVERY_CODE_MAX_ATTEMPTS,
            })
        );

        const response = await confirmPOST(
            jsonRequest(
                "http://test/api/orders/recover/confirm",
                {
                    challengeId: "challenge-1",
                    code: "123456",
                    email: nextContact().email,
                },
                nextIp()
            )
        );

        expect(response.status).toBe(429);
    });
});
