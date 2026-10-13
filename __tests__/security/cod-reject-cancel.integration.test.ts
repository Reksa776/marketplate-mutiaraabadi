/**
 * ==========================================
 * COD REJECT & CANCEL — REAL DATABASE INTEGRATION
 * ==========================================
 *
 * REJECT is a REJECT & CANCEL: the review decision and the release of
 * every reserved resource commit in ONE transaction. A mocked Prisma
 * client cannot prove what this suite proves against the real MariaDB
 * (database `toko`):
 *
 *   1. the reservation is really GIVEN BACK — variant stock, Product.sold,
 *      the voucher's global usedCount AND the per-scope usage bucket —
 *      each exactly once,
 *   2. the review transition is really CONDITIONAL (PENDING → REJECTED),
 *      so two concurrent rejections cannot each release,
 *   3. the shipment job is STOPPED (status CANCELLED) and the row is
 *      KEPT, and
 *   4. historical records are PRESERVED: the order and its items survive
 *      (soft-cancel only), and a second rejection releases NOTHING more.
 *
 * No payment provider, courier or Mengantar call is made. Every row is
 * created with a unique suffix and deleted in afterAll.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { rejectAndCancelCodOrder } from "@/lib/cod-review";
import {
    buildGuestIdentityKey,
    ownerKeyForGuest,
} from "@/lib/guest-identity";

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "cod-reject-cancel-integration-secret";

jest.setTimeout(60000);

const SUFFIX = `crc-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const ADMIN_ID = "admin-integration";

const GUEST_IDENTITY = buildGuestIdentityKey({
    email: `${SUFFIX}@ctest.local`,
    phone: "081200009876",
})!;

const OWNER_KEY = ownerKeyForGuest(GUEST_IDENTITY);

const createdOrderIds: number[] = [];
const createdProductIds: number[] = [];
const createdVoucherIds: number[] = [];

/** Product.slug / Voucher.code are unique — one tag per seeded bundle. */
let seedCounter = 0;

/* ==========================================
 * SEEDING
 * ========================================== */

async function seedResources() {
    seedCounter += 1;

    const tag = `${SUFFIX}-${seedCounter}`;

    const product = await prisma.product.create({
        data: {
            name: `CRC-TEST-${tag}`,
            slug: `crc-test-${tag}`,
            category: "test",
        },
    });

    const variant = await prisma.productVariant.create({
        data: {
            productId: product.id,
            name: `CRC-VARIANT-${tag}`,
            price: new Prisma.Decimal(100_000),
            stock: 10,
            weight: 500,
        },
    });

    const voucher = await prisma.voucher.create({
        data: {
            code: `CRCTEST-${tag}`.toUpperCase(),
            type: "PERCENTAGE",
            value: new Prisma.Decimal(10),
            isActive: true,
            maxUsagePerUser: 1,
            usedCount: 1,
        },
    });

    const usage = await prisma.voucherUserUsage.create({
        data: {
            voucherId: voucher.id,
            ownerKey: OWNER_KEY,
            usageCount: 1,
        },
    });

    createdProductIds.push(product.id);
    createdVoucherIds.push(voucher.id);

    return { product, variant, voucher, usage, tag };
}

/**
 * A flagged COD order exactly as checkout leaves it: reservations
 * CONSUMED (stock and sold already moved), the voucher's quota and the
 * guest's usage bucket already spent, and a shipment job queued.
 */
async function seedFlaggedCodOrder(input: {
    product: { id: number };
    variant: { id: number };
    voucher: { id: number; code: string };
    tag: string;
    codReviewStatus: string;
    withVoucher?: boolean;
}) {
    const qty = 2;

    const order = await prisma.order.create({
        data: {
            orderNumber: `IT-CRC-${SUFFIX}-${createdOrderIds.length}`,
            recipientName: "IT COD Buyer",
            phone: "081200009876",
            address: "Jl. Integration No. 2",
            subtotal: new Prisma.Decimal(200_000),
            shippingCost: new Prisma.Decimal(20_000),
            total: new Prisma.Decimal(220_000),
            status: "PENDING",
            paymentMethod: "COD",
            paymentStatus: "UNPAID",
            customerEmail: `${SUFFIX}@ctest.local`,
            guestIdentityKey: GUEST_IDENTITY,
            requiresCodReview: true,
            codReviewStatus: input.codReviewStatus,
            shippingProvider: "MENGANTAR",
            providerCourier: "JNE",
            shipmentStatus: "SHIPMENT_PENDING",
            voucherId:
                input.withVoucher === false
                    ? null
                    : input.voucher.id,
            voucherCode:
                input.withVoucher === false
                    ? null
                    : input.voucher.code,
            discount: new Prisma.Decimal(20_000),
            items: {
                create: [
                    {
                        productId: input.product.id,
                        variantId: input.variant.id,
                        productName: `CRC-TEST-${input.tag}`,
                        variantName: `CRC-VARIANT-${input.tag}`,
                        price: new Prisma.Decimal(100_000),
                        quantity: qty,
                        subtotal: new Prisma.Decimal(200_000),
                    },
                ],
            },
        },
    });

    createdOrderIds.push(order.id);

    // Consume the reservations, as checkout does.
    await prisma.productVariant.update({
        where: { id: input.variant.id },
        data: { stock: { decrement: qty } },
    });

    await prisma.$executeRaw`
        UPDATE product
        SET sold = sold + ${qty}
        WHERE id = ${input.product.id}
    `;

    const job = await prisma.shipmentJob.create({
        data: {
            orderId: order.id,
            status: "PENDING",
            stage: "CREATE",
        },
    });

    return { order, job, qty };
}

async function readState(
    orderId: number,
    variantId: number,
    voucherId: number
) {
    const [order, variant, usage, job, itemCount] =
        await Promise.all([
            prisma.order.findUnique({
                where: { id: orderId },
                select: {
                    status: true,
                    paymentStatus: true,
                    codReviewStatus: true,
                    codReviewedAt: true,
                    codReviewedBy: true,
                },
            }),
            prisma.productVariant.findUnique({
                where: { id: variantId },
                select: { stock: true },
            }),
            prisma.voucherUserUsage.findUnique({
                where: {
                    voucherId_ownerKey: {
                        voucherId,
                        ownerKey: OWNER_KEY,
                    },
                },
                select: { usageCount: true },
            }),
            prisma.shipmentJob.findUnique({
                where: { orderId },
                select: { status: true },
            }),
            prisma.orderItem.count({ where: { orderId } }),
        ]);

    return { order, variant, usage, job, itemCount };
}

afterAll(async () => {
    if (createdOrderIds.length > 0) {
        await prisma.order.deleteMany({
            where: { id: { in: createdOrderIds } },
        });
    }

    if (createdVoucherIds.length > 0) {
        await prisma.voucher.deleteMany({
            where: { id: { in: createdVoucherIds } },
        });
    }

    if (createdProductIds.length > 0) {
        await prisma.product.deleteMany({
            where: { id: { in: createdProductIds } },
        });
    }

    await prisma.$disconnect();
});

/* ==========================================
 * REJECT & CANCEL
 * ========================================== */

describe("rejectAndCancelCodOrder against the real database", () => {
    test("rejecting releases every reservation exactly once and keeps history", async () => {
        const { product, variant, voucher, tag } =
            await seedResources();

        const { order, qty } = await seedFlaggedCodOrder({
            product,
            variant,
            voucher,
            tag,
            codReviewStatus: "PENDING",
        });

        // Pre-rejection: reservations consumed.
        const before = await readState(
            order.id,
            variant.id,
            voucher.id
        );

        expect(before.variant!.stock).toBe(10 - qty);
        expect(before.job!.status).toBe("PENDING");

        const result = await rejectAndCancelCodOrder({
            orderId: order.id,
            adminId: ADMIN_ID,
            note: "Alamat tidak jelas",
        });

        expect(result).toMatchObject({
            ok: true,
            changed: true,
            cancelled: true,
            shipmentJobsStopped: 1,
        });

        const after = await readState(
            order.id,
            variant.id,
            voucher.id
        );

        // Order soft-cancelled + review recorded.
        expect(after.order!.status).toBe("CANCELLED");
        expect(after.order!.paymentStatus).toBe("FAILED");
        expect(after.order!.codReviewStatus).toBe("REJECTED");
        expect(after.order!.codReviewedBy).toBe(ADMIN_ID);
        expect(after.order!.codReviewedAt).not.toBeNull();

        // Stock and sold given back.
        expect(after.variant!.stock).toBe(10);
        expect(after.usage!.usageCount).toBe(0);

        const productRow = await prisma.product.findUnique({
            where: { id: product.id },
            select: { sold: true },
        });

        expect(productRow!.sold).toBe(0);

        // Voucher quota returned (global + per scope).
        const voucherRow = await prisma.voucher.findUnique({
            where: { id: voucher.id },
            select: { usedCount: true },
        });

        expect(voucherRow!.usedCount).toBe(0);

        // The shipment job is STOPPED but KEPT.
        expect(after.job!.status).toBe("CANCELLED");

        // History is preserved: the order and its item still exist.
        expect(after.itemCount).toBe(1);
    });

    test("a repeated rejection releases nothing a second time", async () => {
        const { product, variant, voucher, tag } =
            await seedResources();

        const { order, qty } = await seedFlaggedCodOrder({
            product,
            variant,
            voucher,
            tag,
            codReviewStatus: "PENDING",
        });

        const first = await rejectAndCancelCodOrder({
            orderId: order.id,
            adminId: ADMIN_ID,
        });

        expect(first).toMatchObject({
            ok: true,
            cancelled: true,
        });

        const afterFirst = await readState(
            order.id,
            variant.id,
            voucher.id
        );

        expect(afterFirst.variant!.stock).toBe(10);

        // Replay the decision (a retried request, a second admin).
        const second = await rejectAndCancelCodOrder({
            orderId: order.id,
            adminId: "admin-other",
        });

        expect(second).toMatchObject({
            ok: true,
            changed: false,
            cancelled: false,
            shipmentJobsStopped: 0,
        });

        const afterSecond = await readState(
            order.id,
            variant.id,
            voucher.id
        );

        // No double release: the reservation cannot be inflated.
        expect(afterSecond.variant!.stock).toBe(10);
        expect(afterSecond.usage!.usageCount).toBe(0);

        const productRow = await prisma.product.findUnique({
            where: { id: product.id },
            select: { sold: true },
        });

        expect(productRow!.sold).toBe(0);

        const voucherRow = await prisma.voucher.findUnique({
            where: { id: voucher.id },
            select: { usedCount: true },
        });

        expect(voucherRow!.usedCount).toBe(0);

        // The original reviewer keeps the record.
        expect(afterSecond.order!.codReviewedBy).toBe(
            ADMIN_ID
        );

        expect(qty).toBe(2);
    });

    test("two concurrent rejections release exactly once", async () => {
        const { product, variant, voucher, tag } =
            await seedResources();

        const { order, qty } = await seedFlaggedCodOrder({
            product,
            variant,
            voucher,
            tag,
            codReviewStatus: "PENDING",
        });

        const [first, second] = await Promise.all([
            rejectAndCancelCodOrder({
                orderId: order.id,
                adminId: "admin-a",
            }),
            rejectAndCancelCodOrder({
                orderId: order.id,
                adminId: "admin-b",
            }),
        ]);

        // Exactly one call performs the transition AND the release; the
        // other reports the authoritative state.
        const releasers = [first, second].filter(
            (outcome) => outcome.ok && outcome.cancelled
        );

        expect(releasers).toHaveLength(1);

        const losers = [first, second].filter(
            (outcome) => !outcome.ok
        );

        for (const loser of losers) {
            expect(
                (loser as { reason: string }).reason
            ).toBe("ALREADY_DECIDED");
        }

        const after = await readState(
            order.id,
            variant.id,
            voucher.id
        );

        // One release, not two: the stock is exactly back to 10.
        expect(after.variant!.stock).toBe(10);
        expect(after.order!.status).toBe("CANCELLED");
        expect(after.order!.codReviewStatus).toBe("REJECTED");
        expect(qty).toBe(2);
    });

    test("an APPROVED order is never cancelled or released", async () => {
        const { product, variant, voucher, tag } =
            await seedResources();

        const { order } = await seedFlaggedCodOrder({
            product,
            variant,
            voucher,
            tag,
            codReviewStatus: "APPROVED",
        });

        await expect(
            rejectAndCancelCodOrder({
                orderId: order.id,
                adminId: ADMIN_ID,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "ALREADY_APPROVED",
        });

        const after = await readState(
            order.id,
            variant.id,
            voucher.id
        );

        // Untouched: the order keeps its hold-released state and the
        // reservation stays consumed.
        expect(after.order!.status).toBe("PENDING");
        expect(after.order!.codReviewStatus).toBe("APPROVED");
        expect(after.variant!.stock).toBe(8);
        expect(after.job!.status).toBe("PENDING");
    });

    test("an order that needs no review is refused", async () => {
        const order = await prisma.order.create({
            data: {
                orderNumber: `IT-CRC-${SUFFIX}-plain`,
                recipientName: "IT Plain Buyer",
                phone: "081200009876",
                address: "Jl. Integration No. 3",
                subtotal: new Prisma.Decimal(50_000),
                shippingCost: new Prisma.Decimal(10_000),
                total: new Prisma.Decimal(60_000),
                status: "PENDING",
                paymentMethod: "COD",
                paymentStatus: "UNPAID",
                requiresCodReview: false,
            },
        });

        createdOrderIds.push(order.id);

        await expect(
            rejectAndCancelCodOrder({
                orderId: order.id,
                adminId: ADMIN_ID,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_REVIEWABLE",
        });

        const untouched = await prisma.order.findUnique({
            where: { id: order.id },
            select: { status: true },
        });

        expect(untouched!.status).toBe("PENDING");
    });

    test("an unknown order id is NOT_FOUND", async () => {
        await expect(
            rejectAndCancelCodOrder({
                orderId: 2_000_000_001,
                adminId: ADMIN_ID,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });
    });
});
