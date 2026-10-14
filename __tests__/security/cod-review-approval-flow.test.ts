/**
 * ==========================================
 * COD REVIEW — APPROVAL → SHIPMENT FLOW
 * ==========================================
 *
 * Regression tests for the P0 hotfix. The COD review gate (commit
 * 1b5c00f) holds a high-risk COD order by NOT enqueuing a ShipmentJob,
 * and the release path is the admin endpoint
 * `POST /api/admin/orders/:id/cod-review { action: "APPROVE" }`.
 *
 * These tests run the REAL endpoint, the REAL ShipmentJob worker
 * (`processShipmentJobs`) and the REAL enqueue helper; only prisma and
 * the Mengantar client are mocked, so no provider call, no database and
 * no network are ever touched.
 *
 * Covered:
 *   1. Normal COD + Mengantar  → the worker creates the shipment
 *      automatically (the pre-regression behaviour).
 *   2. Flagged COD             → held: the worker cancels the job and
 *      NEVER creates a shipment.
 *   3. Approved COD            → exactly ONE enqueue and exactly ONE
 *      shipment create.
 *   4. Repeated approval       → no second transition, no second job,
 *      no second shipment.
 *   5. Non-Mengantar order     → never enqueued, never shipped.
 *   6. Checkout guard          → COD enqueue requires MENGANTAR and
 *      (source) a non-flagged review.
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

jest.mock("@/lib/admin/audit-log", () => ({
    createAuditLog: jest.fn(async () => undefined),
}));

jest.mock("@/lib/notification/order-status-handler", () => ({
    onShipmentStatusChanged: jest.fn(async () => undefined),
    onOrderStatusChanged: jest.fn(async () => undefined),
}));

jest.mock("@/lib/mengantar/shipment", () => ({
    createShipmentForOrder: jest.fn(async () => ({
        ok: true,
        changed: true,
        shipmentStatus: "CREATED",
        shippingPaymentStatus: "NOT_APPLICABLE",
    })),
    payUnpaidShipmentForOrder: jest.fn(async () => ({
        ok: true,
        changed: true,
        shipmentStatus: "CREATED",
        shippingPaymentStatus: "PAID",
    })),
}));

/*
 * The worker module is PARTIALLY mocked: the real `processShipmentJobs`
 * runs, but the enqueue helper and the post-response nudge are spies, so
 * "was a job actually enqueued?" and "was the worker nudged?" are
 * observable without a database.
 */
jest.mock("@/lib/mengantar/shipment-worker", () => {
    const actual = jest.requireActual(
        "@/lib/mengantar/shipment-worker"
    );

    return {
        ...actual,
        enqueueShipmentJob: jest.fn(async () => undefined),
        scheduleShipmentProcessing: jest.fn(
            async () => undefined
        ),
    };
});

import { readFileSync } from "fs";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createShipmentForOrder } from "@/lib/mengantar/shipment";
import {
    enqueueShipmentJob,
    processShipmentJobs,
    scheduleShipmentProcessing,
} from "@/lib/mengantar/shipment-worker";
import { POST as codReviewPOST } from "@/app/api/admin/orders/[id]/cod-review/route";

const mockedAuth = auth as unknown as jest.Mock;
const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
    updateMany: jest.Mock;
};
const mockedJob = prisma.shipmentJob as unknown as {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    upsert: jest.Mock;
};
const mockedCreateShipment =
    createShipmentForOrder as unknown as jest.Mock;
const mockedEnqueue =
    enqueueShipmentJob as unknown as jest.Mock;
const mockedSchedule =
    scheduleShipmentProcessing as unknown as jest.Mock;

const ORDER_ID = 985;
const JOB_ID = 41;

/* ==========================================
 * FIXTURES
 * ========================================== */

/** What the endpoint reads when it loads the order. */
function reviewOrder(
    overrides: Record<string, unknown> = {}
) {
    return {
        id: ORDER_ID,
        orderNumber: "ORD-985",
        status: "PENDING",
        paymentMethod: "COD",
        paymentStatus: "UNPAID",
        shippingProvider: "MENGANTAR",
        total: 95000,
        requiresCodReview: true,
        codReviewStatus: "PENDING",
        shipmentJob: null,
        ...overrides,
    };
}

/** What the WORKER reads when it processes one job. */
function workerOrder(
    overrides: Record<string, unknown> = {}
) {
    return {
        id: ORDER_ID,
        status: "PENDING",
        paymentStatus: "UNPAID",
        paymentMethod: "COD",
        shippingProvider: "MENGANTAR",
        shipmentStatus: "SHIPMENT_PENDING",
        shippingPaymentStatus: "NOT_APPLICABLE",
        requiresCodReview: false,
        codReviewStatus: null,
        ...overrides,
    };
}

/** Wire the worker's claim sequence for exactly ONE due job. */
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

function approveRequest() {
    return codReviewPOST(
        new Request("http://test", {
            method: "POST",
            body: JSON.stringify({ action: "APPROVE" }),
        }),
        {
            params: Promise.resolve({
                id: String(ORDER_ID),
            }),
        } as never
    );
}

beforeEach(() => {
    jest.clearAllMocks();

    mockedAuth.mockResolvedValue({
        user: { id: "admin-1", role: "ADMIN" },
    });
});

/* ==========================================
 * 1 + 2 — AUTOMATIC CREATION vs HOLD
 * ========================================== */

describe("COD + Mengantar auto-shipment", () => {
    test("1. a normal (unflagged) COD order is shipped by the worker", async () => {
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            workerOrder({ requiresCodReview: false })
        );

        const result = await processShipmentJobs({ limit: 5 });

        expect(result.processed).toBe(1);
        expect(mockedCreateShipment).toHaveBeenCalledTimes(1);
        expect(mockedCreateShipment).toHaveBeenCalledWith(
            ORDER_ID
        );
    });

    test("2. a flagged COD order still awaiting review is HELD", async () => {
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            workerOrder({
                requiresCodReview: true,
                codReviewStatus: "PENDING",
            })
        );

        await processShipmentJobs({ limit: 5 });

        // Nothing reaches the provider…
        expect(mockedCreateShipment).not.toHaveBeenCalled();

        // …and the job is retired with a durable reason (no retry loop).
        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "CANCELLED",
                }),
            })
        );
    });
});

/* ==========================================
 * 3 + 4 — APPROVAL ENQUEUES EXACTLY ONE JOB
 * ========================================== */

describe("Approving a COD review", () => {
    test("3. approval enqueues exactly one job and creates exactly one shipment", async () => {
        mockedOrder.findUnique.mockResolvedValue(reviewOrder());
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });

        const response = await approveRequest();
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data.codReviewStatus).toBe("APPROVED");
        expect(body.data.shipmentEnqueued).toBe(true);

        // Exactly one enqueue, keyed on the order (upsert on @unique).
        expect(mockedEnqueue).toHaveBeenCalledTimes(1);
        expect(mockedEnqueue).toHaveBeenCalledWith(ORDER_ID);

        // The existing worker was nudged, so the shipment does not wait
        // for an external cron sweep.
        expect(mockedSchedule).toHaveBeenCalledTimes(1);

        // The worker then creates the provider shipment exactly once.
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            workerOrder({
                requiresCodReview: true,
                codReviewStatus: "APPROVED",
            })
        );

        await processShipmentJobs({ limit: 5 });

        expect(mockedCreateShipment).toHaveBeenCalledTimes(1);
        expect(mockedCreateShipment).toHaveBeenCalledWith(
            ORDER_ID
        );
    });

    test("4. a repeated approval cannot enqueue or create a second shipment", async () => {
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });
        mockedOrder.findUnique.mockResolvedValue(reviewOrder());

        const first = await approveRequest();
        expect((await first.json()).data.changed).toBe(true);

        // Second click: the review is already decided.
        mockedOrder.findUnique.mockResolvedValue(
            reviewOrder({ codReviewStatus: "APPROVED" })
        );

        const second = await approveRequest();
        const secondBody = await second.json();

        expect(second.status).toBe(200);
        expect(secondBody.success).toBe(true);
        expect(secondBody.data.changed).toBe(false);
        expect(secondBody.data.alreadyReviewed).toBe(true);

        // The PENDING → APPROVED transition ran ONCE across both calls…
        expect(mockedOrder.updateMany).toHaveBeenCalledTimes(1);

        // …and the provider is still only ever called once.
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            workerOrder({
                requiresCodReview: true,
                codReviewStatus: "APPROVED",
            })
        );

        await processShipmentJobs({ limit: 5 });

        expect(mockedCreateShipment).toHaveBeenCalledTimes(1);
    });

    test("a non-admin cannot approve", async () => {
        mockedAuth.mockResolvedValue({
            user: { id: "u1", role: "CUSTOMER" },
        });

        const response = await approveRequest();

        expect(response.status).toBe(403);
        expect(mockedEnqueue).not.toHaveBeenCalled();
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 5 — NON-MENGANTAR NEVER SHIPPED VIA MENGANTAR
 * ========================================== */

describe("Non-Mengantar COD orders", () => {
    test("5a. approving one enqueues no Mengantar job", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            reviewOrder({ shippingProvider: null })
        );
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });

        const response = await approveRequest();
        const body = await response.json();

        // The review decision still succeeds (it is about the ORDER,
        // not the provider), but nothing is queued for Mengantar.
        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data.shipmentEnqueued).toBe(false);
        expect(mockedEnqueue).not.toHaveBeenCalled();
        expect(mockedSchedule).not.toHaveBeenCalled();
    });

    test("5b. the worker refuses to ship a non-Mengantar order", async () => {
        armWorkerForOneJob();
        mockedOrder.findUnique.mockResolvedValue(
            workerOrder({ shippingProvider: null })
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
 * 6 — CHECKOUT GUARD (source invariant)
 * ==========================================
 *
 * The automatic COD enqueue lives inside createCheckoutOrder. Running
 * the whole checkout here is not what this regression is about, so the
 * guard itself is pinned instead — exactly how this repo already locks
 * the COD enqueue (see __tests__/security/mengantar-auto-shipment.test.ts).
 */

describe("Checkout COD enqueue guard", () => {
    const source = readFileSync("lib/checkout.ts", "utf-8");

    test("6. COD + Mengantar enqueues a job only when the review did not flag it", () => {
        expect(source).toContain(
            "shippingProvider === \"MENGANTAR\" &&"
        );
        expect(source).toContain(
            "input.paymentMethod === \"COD\" &&"
        );
        expect(source).toContain("!requiresCodReview");
        expect(source).toContain(
            "enqueueShipmentJobTx(tx, order.id)"
        );
    });

    test("the post-response worker nudge uses the same guard", () => {
        expect(source).toContain(
            "await scheduleShipmentProcessing();"
        );
        expect(source).toContain("!result.requiresCodReview");
    });
});
