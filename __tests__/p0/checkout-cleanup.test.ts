/**
 * ==========================================
 * PENDING CHECKOUT CLEANUP SAFETY
 * ==========================================
 *
 * BLOCKER 3 — cleanup must not cancel a still-payable payment order,
 * otherwise a late payment becomes a "paid-but-cancelled" order.
 *
 * Covers:
 *   A/D  still-valid instruction      → left PENDING
 *   B/E  expired instruction          → rolled back
 *   null expiry + instruction present → left PENDING (cannot prove dead)
 *   null expiry + no instruction      → rolled back
 */

jest.mock("@/lib/prisma", () => {
    const tx = {
        $executeRaw: jest.fn(async () => 0),
        order: { findUnique: jest.fn(), update: jest.fn() },
        cart: { findUnique: jest.fn(), create: jest.fn() },
        cartItem: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
    };
    return {
        prisma: {
            order: { findMany: jest.fn() },
            $transaction: jest.fn(async (fn: any) => fn(tx)),
            __tx: tx,
        },
    };
});

const { prisma } = require("@/lib/prisma") as any;

import {
    cleanupPendingCheckoutOrders,
    isPendingOrderStillPayable,
} from "@/lib/checkout";

const NOW = Date.now();
const FUTURE = new Date(NOW + 60 * 60 * 1000);
const PAST = new Date(NOW - 60 * 60 * 1000);

beforeEach(() => {
    jest.clearAllMocks();
});

describe("isPendingOrderStillPayable", () => {
    test("open window → payable", () => {
        expect(
            isPendingOrderStillPayable(
                {
                    paymentNo: "123",
                    paymentUrl: null,
                    paymentExpiresAt: FUTURE,
                },
                NOW
            )
        ).toBe(true);
    });

    test("expired window → not payable", () => {
        expect(
            isPendingOrderStillPayable(
                {
                    paymentNo: "123",
                    paymentUrl: null,
                    paymentExpiresAt: PAST,
                },
                NOW
            )
        ).toBe(false);
    });

    test("within grace after nominal expiry → still payable", () => {
        const justExpired = new Date(NOW - 60 * 1000);
        expect(
            isPendingOrderStillPayable(
                {
                    paymentNo: "123",
                    paymentUrl: null,
                    paymentExpiresAt: justExpired,
                },
                NOW
            )
        ).toBe(true);
    });

    test("no expiry but an instruction exists → payable (never guess)", () => {
        expect(
            isPendingOrderStillPayable(
                {
                    paymentNo: null,
                    paymentUrl: "https://qr",
                    paymentExpiresAt: null,
                },
                NOW
            )
        ).toBe(true);
    });

    test("no expiry and no instruction → not payable", () => {
        expect(
            isPendingOrderStillPayable(
                {
                    paymentNo: null,
                    paymentUrl: null,
                    paymentExpiresAt: null,
                },
                NOW
            )
        ).toBe(false);
    });
});

describe("cleanupPendingCheckoutOrders", () => {
    test("leaves still-valid orders PENDING (no rollback)", async () => {
        prisma.order.findMany.mockResolvedValue([
            {
                id: 1,
                orderNumber: "PAY-CART-1",
                paymentNo: "123",
                paymentUrl: null,
                paymentExpiresAt: FUTURE,
            },
        ]);

        await cleanupPendingCheckoutOrders("user-1");

        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    test("rolls back an actually-expired order", async () => {
        prisma.order.findMany.mockResolvedValue([
            {
                id: 2,
                orderNumber: "PAY-CART-2",
                paymentNo: "456",
                paymentUrl: null,
                paymentExpiresAt: PAST,
            },
        ]);

        await cleanupPendingCheckoutOrders("user-1");

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    test("mixed batch: only the expired order is rolled back", async () => {
        prisma.order.findMany.mockResolvedValue([
            {
                id: 1,
                orderNumber: "PAY-CART-1",
                paymentNo: "123",
                paymentUrl: null,
                paymentExpiresAt: FUTURE,
            },
            {
                id: 2,
                orderNumber: "PAY-CART-2",
                paymentNo: "456",
                paymentUrl: null,
                paymentExpiresAt: PAST,
            },
            {
                id: 3,
                orderNumber: "PAY-CART-3",
                paymentNo: null,
                paymentUrl: "https://qr",
                paymentExpiresAt: null,
            },
            {
                id: 4,
                orderNumber: "PAY-CART-4",
                paymentNo: null,
                paymentUrl: null,
                paymentExpiresAt: null,
            },
        ]);

        await cleanupPendingCheckoutOrders("user-1");

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });
});
