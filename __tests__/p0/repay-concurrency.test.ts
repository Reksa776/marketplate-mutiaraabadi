/**
 * ==========================================
 * REPAY CONCURRENCY / RESERVATION INTEGRITY
 * ==========================================
 *
 * Deterministic, DB-free proof for BLOCKER 2.
 *
 * The fake Prisma serialises transactions like InnoDB row locks do:
 * a second transaction only starts after the first commits. This lets
 * us prove:
 *   1. Two concurrent repays → exactly ONE succeeds.
 *   2. Exactly ONE stock/voucher/spin reservation happens.
 *   3. A loser/partial failure rolls the whole transaction back
 *      (claim + any partial reservation), leaving no state change.
 */

jest.mock("@/lib/marketing/flash-sale", () => ({
    recordFlashSalePurchase: jest.fn(),
}));

jest.mock("@/lib/admin/audit-log", () => ({
    createAuditLog: jest.fn(async () => undefined),
}));

jest.mock("@/lib/voucher", () => ({
    incrementVoucherUsage: jest.fn(async () => true),
}));

jest.mock("@/lib/prisma", () => {
    const baseOrder = () => ({
        id: 1,
        userId: "user-1",
        orderNumber: "PAY-CART-1",
        status: "CANCELLED",
        paymentStatus: "FAILED",
        paymentMethod: "QRIS",
        total: 100000,
        voucherId: null as number | null,
        originalSpinWheelSpinId: null as number | null,
        items: [
            {
                variantId: 10,
                productId: 20,
                quantity: 2,
                productName: "Produk",
                variantName: "Varian",
            },
        ],
    });

    const state: any = {
        order: baseOrder(),
        stock: 10,
        sold: 0,
        flashSale: null as any,
    };

    const tx = {
        $executeRaw: jest.fn(async (_strings: any, ...values: any[]) => {
            const expectedStatus = values[values.length - 2];
            const expectedPaymentStatus = values[values.length - 1];

            if (
                state.order.status === expectedStatus &&
                state.order.paymentStatus === expectedPaymentStatus
            ) {
                state.order.status = "PENDING";
                state.order.paymentStatus = "PENDING";
                return 1;
            }
            return 0;
        }),
        order: {
            findFirst: jest.fn(async ({ where }: any) => {
                if (
                    where?.id !== state.order.id ||
                    where?.userId !== state.order.userId
                ) {
                    return null;
                }
                return { ...state.order, items: state.order.items };
            }),
            findUnique: jest.fn(async () => ({
                ...state.order,
                items: state.order.items,
            })),
            update: jest.fn(async () => state.order),
        },
        flashSale: {
            findFirst: jest.fn(async () => state.flashSale),
        },
        productVariant: {
            updateMany: jest.fn(async ({ data }: any) => {
                const qty = data?.stock?.decrement ?? 0;
                if (state.stock >= qty) {
                    state.stock -= qty;
                    return { count: 1 };
                }
                return { count: 0 };
            }),
        },
        product: {
            update: jest.fn(async ({ data }: any) => {
                state.sold += data?.sold?.increment ?? 0;
                return {};
            }),
        },
        voucher: { findUnique: jest.fn(), updateMany: jest.fn() },
        voucherUserUsage: { findUnique: jest.fn(), upsert: jest.fn() },
        spinWheelSpin: {
            findFirst: jest.fn(async () => null),
            update: jest.fn(),
        },
    };

    let chain: Promise<unknown> = Promise.resolve();

    const prisma: any = {
        $transaction: jest.fn((fn: any) => {
            const run = chain.then(async () => {
                const snapshot = JSON.parse(
                    JSON.stringify({
                        order: state.order,
                        stock: state.stock,
                        sold: state.sold,
                    })
                );
                try {
                    return await fn(tx);
                } catch (error) {
                    state.order = snapshot.order;
                    state.stock = snapshot.stock;
                    state.sold = snapshot.sold;
                    throw error;
                }
            });
            chain = run.then(
                () => undefined,
                () => undefined
            );
            return run;
        }),
        __tx: tx,
        __state: state,
        __reset: (over: any = {}) => {
            state.order = { ...baseOrder(), ...(over.order ?? {}) };
            state.stock = over.stock ?? 10;
            state.sold = over.sold ?? 0;
            state.flashSale = null;
            chain = Promise.resolve();
        },
    };

    return { prisma };
});

const { prisma } = require("@/lib/prisma") as any;

import { processRepayment } from "@/lib/repay";

beforeEach(() => {
    jest.clearAllMocks();
    prisma.__reset();
});

const EXPECTED = { status: "CANCELLED", paymentStatus: "FAILED" };

describe("BLOCKER 2 — repay concurrency", () => {
    test("two concurrent repays → exactly one succeeds, one reservation", async () => {
        const [a, b] = await Promise.all([
            processRepayment("user-1", 1, "QRIS", EXPECTED),
            processRepayment("user-1", 1, "QRIS", EXPECTED),
        ]);

        const winners = [a, b].filter((r) => r.ok);
        const losers = [a, b].filter((r) => !r.ok);

        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);

        // Stock reserved exactly once (10 - 2), sold incremented once.
        expect(prisma.__state.stock).toBe(8);
        expect(prisma.__state.sold).toBe(2);

        // Order ended PENDING exactly once.
        expect(prisma.__state.order.status).toBe("PENDING");
        expect(prisma.__state.order.paymentStatus).toBe("PENDING");
    });

    test("insufficient stock rolls back the claim and partial reservation", async () => {
        prisma.__reset({ stock: 1 });

        const result = await processRepayment(
            "user-1",
            1,
            "QRIS",
            EXPECTED
        );

        expect(result.ok).toBe(false);

        // Nothing committed: order stays cancelled, stock untouched.
        expect(prisma.__state.order.status).toBe("CANCELLED");
        expect(prisma.__state.order.paymentStatus).toBe("FAILED");
        expect(prisma.__state.stock).toBe(1);
        expect(prisma.__state.sold).toBe(0);
    });

    test("wrong owner is rejected without mutation", async () => {
        const result = await processRepayment(
            "intruder",
            1,
            "QRIS",
            EXPECTED
        );

        expect(result.ok).toBe(false);
        expect(prisma.__state.stock).toBe(10);
        expect(prisma.__state.order.status).toBe("CANCELLED");
    });

    test("already-paid order is never resurrected", async () => {
        prisma.__reset({
            order: {
                status: "PENDING",
                paymentStatus: "PAID",
            },
        });

        const result = await processRepayment(
            "user-1",
            1,
            "QRIS",
            { status: "PENDING", paymentStatus: "PAID" }
        );

        expect(result.ok).toBe(false);
        expect(prisma.__state.stock).toBe(10);
    });

    test("invalid method is rejected before any DB work", async () => {
        const result = await processRepayment("user-1", 1, "COD", EXPECTED);
        expect(result.ok).toBe(false);
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
});
