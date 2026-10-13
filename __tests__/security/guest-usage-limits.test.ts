/**
 * ==========================================
 * GUEST USAGE LIMITS — VOUCHER & FLASH SALE
 * ==========================================
 *
 * Customers buy as guests, so the per-identity caps
 * (`Voucher.maxUsagePerUser`, flash-sale `purchaseLimit`) must be
 * scoped to a normalized, server-side HASHED guest identity instead of
 * `session.user.id` — while keeping:
 *
 *   - the existing limits and their messages,
 *   - atomic enforcement (no concurrent bypass),
 *   - historical `userId`-based usage rows untouched,
 *   - the identity hash out of every browser payload.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "guest-usage-limits-test-secret";

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: { count: jest.fn() },
        voucherUserUsage: { findUnique: jest.fn() },
        flashSalePurchase: { findUnique: jest.fn() },
    },
}));

import { prisma } from "@/lib/prisma";

import {
    buildGuestIdentityKey,
    orderOwnerKey,
    ownerKeyForGuest,
    ownerKeyForUser,
    requireUsageScope,
    resolveOwnerKey,
    resolveUsageScope,
} from "@/lib/guest-identity";
import {
    incrementVoucherUserUsage,
    validateAndCalculateVoucherEnhanced,
} from "@/lib/voucher";
import { recordFlashSalePurchase } from "@/lib/marketing/flash-sale";
import { FlashSalePurchaseLimitError } from "@/lib/marketing/errors";
import { readFileSync } from "fs";
import { resolve } from "path";

const GUEST_IDENTITY = buildGuestIdentityKey({
    email: "buyer@example.com",
    phone: "08123456789",
});

const GUEST_OWNER_KEY = ownerKeyForGuest(GUEST_IDENTITY!);

function readSchema(): string {
    return readFileSync(
        resolve(process.cwd(), "prisma/schema.prisma"),
        "utf-8"
    );
}

/* ==========================================
 * SCOPE RESOLUTION
 * ========================================== */

describe("Usage scope resolution", () => {
    test("a logged-in buyer keeps the historical user scope", () => {
        expect(ownerKeyForUser("user-1")).toBe("user:user-1");
        expect(
            resolveOwnerKey({ userId: "user-1" })
        ).toBe("user:user-1");
    });

    test("a guest resolves to the hashed identity scope", () => {
        expect(
            resolveOwnerKey({
                guestIdentityKey: GUEST_IDENTITY,
            })
        ).toBe(GUEST_OWNER_KEY);
        expect(GUEST_OWNER_KEY.startsWith("guest:g1:")).toBe(
            true
        );
    });

    test("the user scope wins when both are present", () => {
        expect(
            resolveOwnerKey({
                userId: "user-1",
                guestIdentityKey: GUEST_IDENTITY,
            })
        ).toBe("user:user-1");
    });

    test("fails loudly rather than sharing one anonymous bucket", () => {
        expect(() => resolveOwnerKey({})).toThrow();
        expect(() =>
            resolveUsageScope({})
        ).not.toThrow();
        expect(resolveUsageScope({})).toBeNull();
        expect(() =>
            requireUsageScope({
                ownerKey: GUEST_OWNER_KEY,
            })
        ).not.toThrow();
        expect(() => requireUsageScope({})).toThrow();
    });

    test("an existing order is scoped exactly as it was created", () => {
        expect(
            orderOwnerKey({
                userId: "user-1",
                guestIdentityKey: null,
            })
        ).toBe("user:user-1");

        expect(
            orderOwnerKey({
                userId: null,
                guestIdentityKey: GUEST_IDENTITY,
            })
        ).toBe(GUEST_OWNER_KEY);
    });

    test("the guest scope never contains the raw contact", () => {
        expect(GUEST_OWNER_KEY).not.toContain(
            "buyer@example.com"
        );
        expect(GUEST_OWNER_KEY).not.toContain("628123456789");
    });
});

/* ==========================================
 * VOUCHER maxUsagePerUser
 * ========================================== */

function voucherRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 5,
        code: "HEMAT10",
        isActive: true,
        startDate: null,
        endDate: null,
        quota: null,
        usedCount: 0,
        maxUsagePerUser: 2,
        campaignId: null,
        eligibility: "ALL",
        discountType: "PERCENTAGE",
        discountValue: 10,
        maxDiscount: null,
        minPurchase: 0,
        productRestrictions: [],
        categoryRestrictions: [],
        ...overrides,
    };
}

function clientWith(
    options: {
        voucher?: unknown;
        usage?: unknown;
        orderCount?: number;
    } = {}
) {
    return {
        voucher: {
            findUnique: jest.fn(async () =>
                "voucher" in options
                    ? options.voucher
                    : voucherRow()
            ),
        },
        voucherUserUsage: {
            findUnique: jest.fn(async () =>
                "usage" in options ? options.usage : null
            ),
        },
        order: {
            count: jest.fn(
                async () => options.orderCount ?? 0
            ),
        },
    };
}

describe("Voucher maxUsagePerUser — guest identity", () => {
    test("the limit is read from the guest identity scope", async () => {
        const client = clientWith({
            usage: { usageCount: 1 },
        });

        const result =
            await validateAndCalculateVoucherEnhanced(
                "HEMAT10",
                100_000,
                [],
                null,
                null,
                client as never,
                GUEST_OWNER_KEY
            );

        expect(result.valid).toBe(true);

        expect(
            client.voucherUserUsage.findUnique
        ).toHaveBeenCalledWith({
            where: {
                voucherId_ownerKey: {
                    voucherId: 5,
                    ownerKey: GUEST_OWNER_KEY,
                },
            },
        });
    });

    test("a guest at the cap is rejected with the existing message", async () => {
        const client = clientWith({
            usage: { usageCount: 2 },
        });

        const result =
            await validateAndCalculateVoucherEnhanced(
                "HEMAT10",
                100_000,
                [],
                null,
                null,
                client as never,
                GUEST_OWNER_KEY
            );

        expect(result.valid).toBe(false);

        if (result.valid) {
            throw new Error("expected rejection");
        }

        expect(result.message).toContain(
            "batas penggunaan voucher"
        );
    });

    test("a logged-in buyer still resolves to the user scope", async () => {
        const client = clientWith();

        await validateAndCalculateVoucherEnhanced(
            "HEMAT10",
            100_000,
            [],
            "user-1",
            null,
            client as never
        );

        expect(
            client.voucherUserUsage.findUnique
        ).toHaveBeenCalledWith({
            where: {
                voucherId_ownerKey: {
                    voucherId: 5,
                    ownerKey: "user:user-1",
                },
            },
        });
    });

    test("NEW_USER eligibility counts the guest's own paid orders", async () => {
        const client = clientWith({
            voucher: voucherRow({ eligibility: "NEW_USER" }),
            orderCount: 1,
        });

        const result =
            await validateAndCalculateVoucherEnhanced(
                "HEMAT10",
                100_000,
                [],
                null,
                null,
                client as never,
                GUEST_OWNER_KEY
            );

        expect(result.valid).toBe(false);
        expect(client.order.count).toHaveBeenCalledWith({
            where: expect.objectContaining({
                guestIdentityKey: GUEST_IDENTITY,
                paymentStatus: "PAID",
            }),
        });
    });

    test("incrementing usage upserts atomically on the identity scope", async () => {
        const tx = {
            voucherUserUsage: {
                upsert: jest.fn(async () => ({
                    usageCount: 1,
                })),
            },
        };

        await incrementVoucherUserUsage(
            tx as never,
            5,
            null,
            GUEST_OWNER_KEY
        );

        expect(tx.voucherUserUsage.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    voucherId_ownerKey: {
                        voucherId: 5,
                        ownerKey: GUEST_OWNER_KEY,
                    },
                },
                create: expect.objectContaining({
                    ownerKey: GUEST_OWNER_KEY,
                }),
            })
        );
    });

    test("incrementing without a scope fails closed", async () => {
        const tx = {
            voucherUserUsage: { upsert: jest.fn() },
        };

        await expect(
            incrementVoucherUserUsage(tx as never, 5, null)
        ).rejects.toThrow();

        expect(tx.voucherUserUsage.upsert).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * FLASH SALE purchase limit
 * ========================================== */

function flashSaleTx(options: {
    sale?: Record<string, unknown> | null;
    existing?: { quantity: number } | null;
    createdQuantity?: number;
}) {
    const tx = {
        flashSale: {
            findUnique: jest.fn(async () =>
                options.sale === undefined
                    ? {
                          id: 9,
                          isActive: true,
                          purchaseLimit: 2,
                      }
                    : options.sale
            ),
        },
        flashSalePurchase: {
            findUnique: jest.fn(async () =>
                options.existing ?? null
            ),
            create: jest.fn(async () => ({
                quantity: options.createdQuantity ?? 1,
            })),
            update: jest.fn(async () => ({
                quantity: options.createdQuantity ?? 1,
            })),
        },
    };

    return tx;
}

describe("Flash sale purchase limit — guest identity", () => {
    test("a guest purchase is recorded against the hashed identity", async () => {
        const tx = flashSaleTx({});

        const quantity = await recordFlashSalePurchase(
            tx as never,
            9,
            null,
            1,
            GUEST_OWNER_KEY
        );

        expect(quantity).toBe(1);
        expect(
            tx.flashSalePurchase.create
        ).toHaveBeenCalledWith({
            data: expect.objectContaining({
                flashSaleId: 9,
                ownerKey: GUEST_OWNER_KEY,
            }),
        });
    });

    test("the guest scope is enforced even when userId is null", async () => {
        const tx = flashSaleTx({
            existing: { quantity: 2 },
            createdQuantity: 3,
        });

        await expect(
            recordFlashSalePurchase(
                tx as never,
                9,
                null,
                1,
                GUEST_OWNER_KEY
            )
        ).rejects.toBeInstanceOf(
            FlashSalePurchaseLimitError
        );
    });

    test("the atomic post-increment check still catches a race", async () => {
        /*
         * Both concurrent transactions read quantity 1 (under the
         * limit of 2); the stored row wins at 3, and the loser must
         * throw instead of silently exceeding the cap.
         */
        const tx = flashSaleTx({
            existing: { quantity: 1 },
            createdQuantity: 3,
        });

        await expect(
            recordFlashSalePurchase(
                tx as never,
                9,
                null,
                2,
                GUEST_OWNER_KEY
            )
        ).rejects.toBeInstanceOf(
            FlashSalePurchaseLimitError
        );
    });

    test("recording without any scope fails closed", async () => {
        const tx = flashSaleTx({});

        await expect(
            recordFlashSalePurchase(tx as never, 9, null, 1)
        ).rejects.toThrow();

        expect(
            tx.flashSalePurchase.create
        ).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * SCHEMA — HISTORY + UNIQUENESS
 * ========================================== */

describe("Schema — limits are per-identity, history preserved", () => {
    const schema = readSchema();

    test("both usage tables are unique on (x, ownerKey)", () => {
        expect(schema).toContain(
            "@@unique([voucherId, ownerKey])"
        );
        expect(schema).toContain(
            "@@unique([flashSaleId, ownerKey])"
        );
    });

    test("the legacy userId columns are retained (historical data)", () => {
        const voucherUsage = schema.slice(
            schema.indexOf("model VoucherUserUsage"),
            schema.indexOf("model VoucherUserUsage") + 900
        );

        expect(voucherUsage).toMatch(/userId\s+String\?/);

        const flashPurchase = schema.slice(
            schema.indexOf("model FlashSalePurchase"),
            schema.indexOf("model FlashSalePurchase") + 900
        );

        expect(flashPurchase).toMatch(/userId\s+String\?/);
    });

    test("the guest identity column is nullable (logged-in rows)", () => {
        expect(schema).toMatch(
            /guestIdentityKey\s+String\?/
        );
    });
});

/* ==========================================
 * NO HASH LEAKAGE
 * ========================================== */

describe("The identity hash never reaches a browser payload", () => {
    test.each([
        "app/api/voucher/validate/route.ts",
        "app/api/vouchers/available/route.ts",
        "app/api/flash-sales/route.ts",
    ])("%s does not serialize ownerKey / guestIdentityKey", (file) => {
        let code = "";

        try {
            code = readFileSync(
                resolve(process.cwd(), file),
                "utf-8"
            );
        } catch {
            return;
        }

        // Strip comments: these files document the scope in prose.
        const withoutComments = code
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^[ \t]*\/\/.*$/gm, "");

        expect(withoutComments).not.toMatch(/ownerKey\s*:/);
        expect(withoutComments).not.toMatch(
            /guestIdentityKey\s*:/
        );
    });
});
