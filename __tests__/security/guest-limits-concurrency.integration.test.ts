/**
 * ==========================================
 * GUEST USAGE LIMITS — REAL DATABASE INTEGRATION
 * ==========================================
 *
 * These tests EXECUTE THE REAL CODE AGAINST THE REAL MariaDB
 * (database `toko`), like __tests__/p0/remediation.integration.test.ts.
 * They exist because a mocked Prisma client cannot prove the two things
 * that actually protect the per-identity caps:
 *
 *   1. the UNIQUE (voucherId, ownerKey) / (flashSaleId, ownerKey)
 *      indexes — the real guarantee that a guest scope is enforced
 *      rather than silently skipped because userId is NULL, and
 *   2. ATOMICITY under concurrent requests — the loser must fail
 *      (fail-closed) and the winner's row must never exceed the limit,
 *      with a full transaction ROLLBACK on failure so no quota leaks.
 *
 * No production data is touched: every row is created with a unique
 * suffix and deleted in afterAll. No payment provider or Mengantar call
 * is made.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
    incrementVoucherUserUsage,
    validateAndCalculateVoucherEnhanced,
} from "@/lib/voucher";
import { recordFlashSalePurchase } from "@/lib/marketing/flash-sale";
import {
    buildGuestIdentityKey,
    ownerKeyForGuest,
} from "@/lib/guest-identity";

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "guest-limits-integration-secret";

jest.setTimeout(60000);

const SUFFIX = `gl-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const GUEST_A = ownerKeyForGuest(
    buildGuestIdentityKey({
        email: `guest-a-${SUFFIX}@gtest.local`,
        phone: "081200000001",
    })!
);

const GUEST_B = ownerKeyForGuest(
    buildGuestIdentityKey({
        email: `guest-b-${SUFFIX}@gtest.local`,
        phone: "081200000002",
    })!
);

/* ==========================================
 * SEEDING
 * ========================================== */

async function seedVoucher(maxUsagePerUser: number | null) {
    return prisma.voucher.create({
        data: {
            code: `GLTEST-${SUFFIX}-${Math.random()
                .toString(36)
                .slice(2, 6)
                .toUpperCase()}`,
            type: "PERCENTAGE",
            value: new Prisma.Decimal(10),
            isActive: true,
            maxUsagePerUser,
        },
    });
}

async function seedFlashSale(purchaseLimit: number) {
    const product = await prisma.product.create({
        data: {
            name: `GL-TEST-${SUFFIX}`,
            slug: `gl-test-${SUFFIX}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
            category: "test",
        },
    });

    const variant = await prisma.productVariant.create({
        data: {
            productId: product.id,
            name: `GL-VARIANT-${SUFFIX}`,
            price: new Prisma.Decimal(100_000),
            stock: 10,
            weight: 100,
        },
    });

    const flashSale = await prisma.flashSale.create({
        data: {
            name: `GL-FS-${SUFFIX}`,
            productId: product.id,
            variantId: variant.id,
            salePrice: new Prisma.Decimal(50_000),
            saleStock: 10,
            purchaseLimit,
            startAt: new Date(Date.now() - 60_000),
            endAt: new Date(Date.now() + 3_600_000),
            isActive: true,
        },
    });

    return { product, variant, flashSale };
}

const createdVoucherIds: number[] = [];
const createdFlashSaleIds: number[] = [];
const createdProductIds: number[] = [];

afterAll(async () => {
    await prisma.voucherUserUsage.deleteMany({
        where: { voucherId: { in: createdVoucherIds } },
    });
    await prisma.flashSalePurchase.deleteMany({
        where: { flashSaleId: { in: createdFlashSaleIds } },
    });
    await prisma.voucher.deleteMany({
        where: { id: { in: createdVoucherIds } },
    });
    await prisma.flashSale.deleteMany({
        where: { id: { in: createdFlashSaleIds } },
    });
    await prisma.productVariant.deleteMany({
        where: { productId: { in: createdProductIds } },
    });
    await prisma.product.deleteMany({
        where: { id: { in: createdProductIds } },
    });
    await prisma.$disconnect();
});

/* ==========================================
 * VOUCHER maxUsagePerUser
 * ========================================== */

describe("Voucher per-identity limit (real DB)", () => {
    test("the guest scope is stored on the unique (voucherId, ownerKey) index", async () => {
        const voucher = await seedVoucher(5);
        createdVoucherIds.push(voucher.id);

        await prisma.$transaction(async (tx) => {
            const count = await incrementVoucherUserUsage(
                tx,
                voucher.id,
                null,
                GUEST_A
            );

            expect(count).toBe(1);
        });

        const row = await prisma.voucherUserUsage.findUnique({
            where: {
                voucherId_ownerKey: {
                    voucherId: voucher.id,
                    ownerKey: GUEST_A,
                },
            },
        });

        expect(row).not.toBeNull();
        expect(row?.ownerKey).toBe(GUEST_A);
        expect(row?.userId).toBeNull();
    });

    test("two guests are separate scopes; the same guest is one scope", async () => {
        const voucher = await seedVoucher(2);
        createdVoucherIds.push(voucher.id);

        await prisma.$transaction((tx) =>
            incrementVoucherUserUsage(tx, voucher.id, null, GUEST_A)
        );
        await prisma.$transaction((tx) =>
            incrementVoucherUserUsage(tx, voucher.id, null, GUEST_B)
        );

        const usages = await prisma.voucherUserUsage.findMany({
            where: { voucherId: voucher.id },
        });

        expect(usages).toHaveLength(2);
        expect(
            new Set(usages.map((u) => u.ownerKey)).size
        ).toBe(2);
    });

    test("concurrent usage for the SAME guest cannot exceed the cap (fail-closed)", async () => {
        const voucher = await seedVoucher(1);
        createdVoucherIds.push(voucher.id);

        /*
         * Mirrors the checkout sequence exactly: validate → increment →
         * post-increment cap check → throw (which rolls the
         * transaction back).
         */
        const attempt = () =>
            prisma
                .$transaction(async (tx) => {
                    const validation =
                        await validateAndCalculateVoucherEnhanced(
                            voucher.code,
                            200_000,
                            [],
                            null,
                            null,
                            tx,
                            GUEST_A
                        );

                    if (!validation.valid) {
                        throw new Error(
                            `REJECTED:${validation.message}`
                        );
                    }

                    const count =
                        await incrementVoucherUserUsage(
                            tx,
                            voucher.id,
                            null,
                            GUEST_A
                        );

                    if (count > 1) {
                        throw new Error("REJECTED:limit");
                    }

                    return count;
                })
                .then((value) => ({ ok: true as const, value }))
                .catch((error) => ({
                    ok: false as const,
                    reason: String(error?.message ?? error),
                }));

        const results = await Promise.all([
            attempt(),
            attempt(),
            attempt(),
        ]);

        const winners = results.filter((r) => r.ok);
        const losers = results.filter((r) => !r.ok);

        /*
         * EXACTLY one wins. The losers fail closed (the cap is enforced
         * either by the in-transaction check or by the unique index),
         * never silently exceeding maxUsagePerUser = 1.
         */
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(2);

        /*
         * Every loser must fail CLOSED with a recognisable rejection
         * (the in-transaction cap check, or the unique index when two
         * transactions insert the same scope concurrently) — never by
         * silently recording a second use.
         */
        expect(
            losers.every((r) =>
                /REJECTED:|P2002|Unique constraint|constraint failed/i.test(
                    r.reason
                )
            )
        ).toBe(true);

        const usages = await prisma.voucherUserUsage.findMany({
            where: { voucherId: voucher.id, ownerKey: GUEST_A },
        });

        expect(usages).toHaveLength(1);
        expect(usages[0].usageCount).toBe(1);
    });

    test("a rejected attempt does not leak quota (rollback)", async () => {
        const voucher = await seedVoucher(1);
        createdVoucherIds.push(voucher.id);

        // First use fills the single slot.
        await prisma.$transaction((tx) =>
            incrementVoucherUserUsage(tx, voucher.id, null, GUEST_A)
        );

        // Second attempt must reject AND roll back its own increment.
        await expect(
            prisma.$transaction(async (tx) => {
                const count = await incrementVoucherUserUsage(
                    tx,
                    voucher.id,
                    null,
                    GUEST_A
                );

                if (count > 1) {
                    throw new Error("REJECTED:limit");
                }
            })
        ).rejects.toThrow("REJECTED:limit");

        const rows = await prisma.voucherUserUsage.findMany({
            where: { voucherId: voucher.id, ownerKey: GUEST_A },
        });

        expect(rows).toHaveLength(1);
        expect(rows[0].usageCount).toBe(1);
    });
});

/* ==========================================
 * FLASH SALE purchaseLimit
 * ========================================== */

describe("Flash sale per-identity limit (real DB)", () => {
    test("concurrent purchases for the same guest cannot exceed purchaseLimit", async () => {
        const { flashSale, product } =
            await seedFlashSale(1);
        createdFlashSaleIds.push(flashSale.id);
        createdProductIds.push(product.id);

        const attempt = () =>
            prisma
                .$transaction(async (tx) => {
                    const quantity = await recordFlashSalePurchase(
                        tx,
                        flashSale.id,
                        null,
                        1,
                        GUEST_A
                    );

                    return quantity;
                })
                .then((value) => ({ ok: true as const, value }))
                .catch((error) => ({
                    ok: false as const,
                    reason: String(
                        error?.message ?? error?.code ?? error
                    ),
                }));

        const results = await Promise.all([
            attempt(),
            attempt(),
        ]);

        expect(results.filter((r) => r.ok)).toHaveLength(1);

        const purchases =
            await prisma.flashSalePurchase.findMany({
                where: {
                    flashSaleId: flashSale.id,
                    ownerKey: GUEST_A,
                },
            });

        expect(purchases).toHaveLength(1);
        expect(purchases[0].quantity).toBeLessThanOrEqual(1);
        expect(purchases[0].userId).toBeNull();
    });

    test("two guests each get their own allowance", async () => {
        const { flashSale, product } =
            await seedFlashSale(1);
        createdFlashSaleIds.push(flashSale.id);
        createdProductIds.push(product.id);

        await prisma.$transaction((tx) =>
            recordFlashSalePurchase(
                tx,
                flashSale.id,
                null,
                1,
                GUEST_A
            )
        );

        const secondGuest = await prisma.$transaction(
            (tx) =>
                recordFlashSalePurchase(
                    tx,
                    flashSale.id,
                    null,
                    1,
                    GUEST_B
                )
        );

        expect(secondGuest).toBe(1);

        const rows = await prisma.flashSalePurchase.findMany({
            where: { flashSaleId: flashSale.id },
        });

        expect(rows).toHaveLength(2);
    });

    test("a rolled-back purchase leaves no row behind", async () => {
        const { flashSale, product } =
            await seedFlashSale(1);
        createdFlashSaleIds.push(flashSale.id);
        createdProductIds.push(product.id);

        await expect(
            prisma.$transaction(async (tx) => {
                await recordFlashSalePurchase(
                    tx,
                    flashSale.id,
                    null,
                    1,
                    GUEST_A
                );

                // Simulate a later failure in the same checkout
                // transaction (e.g. insufficient stock).
                throw new Error("ROLLBACK");
            })
        ).rejects.toThrow("ROLLBACK");

        const rows = await prisma.flashSalePurchase.findMany({
            where: { flashSaleId: flashSale.id },
        });

        expect(rows).toHaveLength(0);
    });
});
