/**
 * ==========================================
 * COD REVIEW IS **NOT** A FULFILMENT GATE — WORKER / RETRY
 * ==========================================
 *
 * REQUIREMENT (owner correction): every successful COD checkout using
 * the MENGANTAR provider must get a ShipmentJob and be shipped
 * automatically, INCLUDING a flagged order whose review is still
 * PENDING. `requiresCodReview` / `codReviewStatus` are a risk marker +
 * audit trail, never a hold.
 *
 * This suite pins that on the BACKGROUND paths, which is where a hold
 * used to hide: a ShipmentJob can be (re)introduced at any time by the
 * sweeper, a reconcile re-queue, or the admin retry button. If any of
 * those consulted the review, a flagged order would silently never ship
 * — the exact production failure (order #985).
 *
 * The real worker code runs; only prisma and the Mengantar client are
 * mocked (no provider call, no database).
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

const mockOrder = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
};

const mockShipmentJob = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    createMany: jest.fn(),
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
        shipmentJob: mockShipmentJob,
    },
}));

jest.mock("@/lib/mengantar", () => ({
    redactMengantarKey: (value: string) => value,
}));

jest.mock("@/lib/mengantar/shipment", () => ({
    createShipmentForOrder: jest.fn(async () => ({
        ok: true,
        changed: true,
        shipmentStatus: "CREATED",
        shippingPaymentStatus: "PAID",
    })),
    payUnpaidShipmentForOrder: jest.fn(async () => ({
        ok: true,
        changed: true,
        shipmentStatus: "CREATED",
        shippingPaymentStatus: "PAID",
    })),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createShipmentForOrder } from "@/lib/mengantar/shipment";

import {
    processShipmentJobs,
    runShipmentJobForOrder,
} from "@/lib/mengantar/shipment-worker";
import { POST as retryPOST } from "@/app/api/admin/orders/[id]/shipment/retry/route";

const mockedAuth = auth as unknown as jest.Mock;
const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
};
const mockedJob = prisma.shipmentJob as unknown as {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    upsert: jest.Mock;
};
const mockedCreateShipment =
    createShipmentForOrder as unknown as jest.Mock;

const ORDER_ID = 963;
const JOB_ID = 12;

function codOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: ORDER_ID,
        status: "PENDING",
        paymentStatus: "UNPAID",
        paymentMethod: "COD",
        shippingProvider: "MENGANTAR",
        shipmentStatus: "SHIPMENT_PENDING",
        shippingPaymentStatus: null,
        requiresCodReview: true,
        codReviewStatus: "PENDING",
        ...overrides,
    };
}

/** Wire the worker's claim sequence for ONE due job. */
function armWorkerForOneJob() {
    mockedJob.updateMany
        // reclaim abandoned PROCESSING jobs
        .mockResolvedValueOnce({ count: 0 })
        // claim the due job
        .mockResolvedValueOnce({ count: 1 })
        // finishJob()
        .mockResolvedValueOnce({ count: 1 });

    mockedJob.findMany.mockResolvedValue([
        { id: JOB_ID, orderId: ORDER_ID },
    ]);

    mockedJob.findUnique.mockResolvedValue({
        id: JOB_ID,
        orderId: ORDER_ID,
        status: "PROCESSING",
        stage: "CREATE",
        attempts: 1,
        maxAttempts: 6,
    });
}

function retryRequest() {
    return retryPOST(new Request("http://test"), {
        params: Promise.resolve({
            id: String(ORDER_ID),
        }),
    } as never);
}

beforeEach(() => {
    jest.clearAllMocks();
});

/* ==========================================
 * 1 — THE WORKER SHIPS EVERY COD ORDER
 * ========================================== */

describe("the shipment worker ignores the COD review state", () => {
    /*
     * The owner requirement is explicit: Order.status = PENDING and a
     * PENDING review must not stop the worker. None of these four cases
     * may be filtered out.
     */
    const cases: Array<[string, Record<string, unknown>]> = [
        ["review PENDING", { codReviewStatus: "PENDING" }],
        ["review APPROVED", { codReviewStatus: "APPROVED" }],
        ["review REJECTED", { codReviewStatus: "REJECTED" }],
        [
            "no review at all",
            { requiresCodReview: false, codReviewStatus: null },
        ],
    ];

    test.each(cases)(
        "a COD order with %s IS shipped",
        async (_label, overrides) => {
            armWorkerForOneJob();
            mockedOrder.findUnique.mockResolvedValue(
                codOrder(overrides)
            );

            const result = await processShipmentJobs({ limit: 5 });

            expect(result.processed).toBe(1);
            expect(mockedCreateShipment).toHaveBeenCalledTimes(1);
            expect(mockedCreateShipment).toHaveBeenCalledWith(
                ORDER_ID
            );

            // Nothing may retire the job as "blocked".
            const cancelled = mockedJob.updateMany.mock.calls.some(
                (call) =>
                    call[0]?.data?.status === "CANCELLED"
            );
            expect(cancelled).toBe(false);
        }
    );

    test("an order still PENDING keeps being processed (no status gate)", async () => {
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ status: "PENDING" })
        );

        await processShipmentJobs({ limit: 5 });

        expect(mockedCreateShipment).toHaveBeenCalledWith(
            ORDER_ID
        );
    });

    test("a REJECTED-flagged non-COD order is not affected either", async () => {
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({
                paymentMethod: "QRIS",
                codReviewStatus: "REJECTED",
            })
        );

        await processShipmentJobs({ limit: 5 });

        expect(mockedCreateShipment).toHaveBeenCalledWith(
            ORDER_ID
        );
    });

    test("a cancelled/refunded order is still NEVER shipped", async () => {
        /*
         * The guard that must remain: fulfilment is governed by the
         * order state, not by the review.
         */
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ status: "CANCELLED" })
        );

        await processShipmentJobs({ limit: 5 });

        expect(mockedCreateShipment).not.toHaveBeenCalled();
        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    status: "PROCESSING",
                }),
                data: expect.objectContaining({
                    status: "CANCELLED",
                }),
            })
        );
    });
});

/* ==========================================
 * 2 — ADMIN RETRY IS A RECOVERY PATH
 * ========================================== */

describe("admin retry is not blocked by a COD review", () => {
    function armRetry() {
        mockedOrder.findUnique.mockResolvedValue(codOrder());
        mockedJob.upsert.mockResolvedValue({
            id: JOB_ID,
            orderId: ORDER_ID,
        });
        mockedJob.updateMany.mockResolvedValue({ count: 1 });
        mockedJob.findUnique.mockResolvedValue({
            id: JOB_ID,
            orderId: ORDER_ID,
            status: "PROCESSING",
            stage: "CREATE",
            attempts: 1,
            maxAttempts: 6,
        });
    }

    test("retrying a REJECTED COD order enqueues and processes", async () => {
        armRetry();
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "REJECTED" })
        );

        const result = await runShipmentJobForOrder(ORDER_ID);

        expect(result.ok).toBe(true);
        expect(mockedJob.upsert).toHaveBeenCalled();
    });

    test("retrying a PENDING-review COD order enqueues and processes", async () => {
        armRetry();

        const result = await runShipmentJobForOrder(ORDER_ID);

        expect(result.ok).toBe(true);
        expect(mockedJob.upsert).toHaveBeenCalled();
    });

    test("the admin retry ENDPOINT returns 200 for a flagged COD order", async () => {
        armRetry();
        mockedAuth.mockResolvedValue({
            user: { id: "admin-1", role: "ADMIN" },
        });

        const response = await retryRequest();
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mockedJob.upsert).toHaveBeenCalled();
    });

    test("a non-admin still cannot retry", async () => {
        armRetry();
        mockedAuth.mockResolvedValue({
            user: { id: "u-1", role: "CUSTOMER" },
        });

        const response = await retryRequest();

        expect(response.status).toBe(403);
        expect(mockedJob.upsert).not.toHaveBeenCalled();
    });
});
