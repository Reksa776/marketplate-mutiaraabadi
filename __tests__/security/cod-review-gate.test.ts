/**
 * ==========================================
 * COD REVIEW GATE — WORKER / RETRY BYPASS TESTS
 * ==========================================
 *
 * A high-risk COD order is held until an authorized admin approves it.
 * The order-creation gate alone is NOT sufficient: a ShipmentJob can be
 * (re)introduced later by the sweeper, a reconcile re-queue or an admin
 * retry. These tests prove the hold is enforced on those paths too, so
 * a REJECTED order can never be shipped by a background process.
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

beforeEach(() => {
    jest.clearAllMocks();
});

describe("Shipment worker honours the COD review hold", () => {
    test("a REJECTED COD order is never shipped by the sweeper", async () => {
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "REJECTED" })
        );

        const result = await processShipmentJobs({ limit: 5 });

        expect(result.processed).toBe(1);
        expect(mockedCreateShipment).not.toHaveBeenCalled();

        // The job is cancelled with a durable reason (no retry loop).
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

    test("a COD order still awaiting review is not shipped either", async () => {
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "PENDING" })
        );

        await processShipmentJobs({ limit: 5 });

        expect(mockedCreateShipment).not.toHaveBeenCalled();
    });

    test("an APPROVED COD order is shipped normally", async () => {
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "APPROVED" })
        );

        await processShipmentJobs({ limit: 5 });

        expect(mockedCreateShipment).toHaveBeenCalledWith(ORDER_ID);
    });

    test("non-flagged COD and non-COD orders are unaffected", async () => {
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({
                requiresCodReview: false,
                codReviewStatus: null,
            })
        );

        await processShipmentJobs({ limit: 5 });

        expect(mockedCreateShipment).toHaveBeenCalledWith(ORDER_ID);
    });

    test("a non-COD order is unaffected even with a stale review flag", async () => {
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({
                paymentMethod: "QRIS",
                codReviewStatus: "REJECTED",
            })
        );

        await processShipmentJobs({ limit: 5 });

        expect(mockedCreateShipment).toHaveBeenCalledWith(ORDER_ID);
    });
});

describe("Admin retry cannot bypass a COD review decision", () => {
    test("retrying a REJECTED COD order is refused before any enqueue", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "REJECTED" })
        );

        const result = await runShipmentJobForOrder(ORDER_ID);

        expect(result.ok).toBe(false);
        expect(result.reason).toContain("tinjauan");
        expect(mockedJob.upsert).not.toHaveBeenCalled();
    });

    test("retrying an APPROVED COD order enqueues and processes", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "APPROVED" })
        );
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

        const result = await runShipmentJobForOrder(ORDER_ID);

        expect(result.ok).toBe(true);
        expect(mockedJob.upsert).toHaveBeenCalled();
    });

    test("the admin retry endpoint surfaces the hold as a 400", async () => {
        mockedAuth.mockResolvedValue({
            user: { id: "admin-1", role: "ADMIN" },
        });
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "REJECTED" })
        );

        const response = await retryPOST(
            new Request("http://test"),
            {
                params: Promise.resolve({
                    id: String(ORDER_ID),
                }),
            } as never
        );
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.success).toBe(false);
        expect(mockedJob.upsert).not.toHaveBeenCalled();
    });
});
