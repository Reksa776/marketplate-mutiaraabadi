/**
 * ==========================================
 * COD AUTO-FULFILMENT — WORKER OUTCOMES
 * ==========================================
 *
 * REQUIREMENT (owner correction): a successful COD + MENGANTAR checkout
 * is shipped automatically, without an admin approving the COD review.
 * These tests pin what happens AFTER the enqueue, on the real worker
 * (`processShipmentJobs` → `processClaimedJob`), with only prisma and the
 * Mengantar create/pay helpers mocked:
 *
 *   S4. worker succeeds              → the job is DONE and the provider
 *                                      pickup schedule is persisted
 *   S5. worker fails                 → the error is RECORDED on the job
 *                                      (retry with backoff, then FAILED)
 *                                      and never silently disappears
 *   S6. repeated processing          → exactly ONE provider shipment
 *                                      (claim CAS + idempotent create)
 *   S8. non-MENGANTAR order          → the worker never creates a
 *                                      Mengantar shipment
 *
 * The review state is deliberately irrelevant here — see
 * cod-review-gate.test.ts — so these run on an unflagged order and one
 * flagged order to prove the outcome does not depend on it.
 *
 * No provider call, no database, no network.
 */

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: {
            findUnique: jest.fn(),
            updateMany: jest.fn(),
        },
        shipmentJob: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            updateMany: jest.fn(),
            upsert: jest.fn(),
        },
    },
}));

jest.mock("@/lib/mengantar", () => ({
    redactMengantarKey: (value: string) => value,
}));

jest.mock("@/lib/mengantar/shipment", () => ({
    createShipmentForOrder: jest.fn(),
    payUnpaidShipmentForOrder: jest.fn(),
}));

jest.mock("@/lib/notification/order-status-handler", () => ({
    onShipmentStatusChanged: jest.fn(async () => undefined),
}));

import { prisma } from "@/lib/prisma";
import {
    createShipmentForOrder,
    payUnpaidShipmentForOrder,
} from "@/lib/mengantar/shipment";
import { processShipmentJobs } from "@/lib/mengantar/shipment-worker";

const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
};
const mockedJob = prisma.shipmentJob as unknown as {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
};
const mockedCreateShipment =
    createShipmentForOrder as unknown as jest.Mock;
const mockedPayShipment =
    payUnpaidShipmentForOrder as unknown as jest.Mock;

const ORDER_ID = 985;
const JOB_ID = 41;

function order(overrides: Record<string, unknown> = {}) {
    return {
        id: ORDER_ID,
        status: "PENDING",
        paymentStatus: "UNPAID",
        paymentMethod: "COD",
        shippingProvider: "MENGANTAR",
        shipmentStatus: "SHIPMENT_PENDING",
        shippingPaymentStatus: null,
        ...overrides,
    };
}

function armJob(attempts = 1, maxAttempts = 6) {
    mockedJob.findMany.mockResolvedValue([
        { id: JOB_ID, orderId: ORDER_ID },
    ]);

    mockedJob.findUnique.mockResolvedValue({
        id: JOB_ID,
        orderId: ORDER_ID,
        status: "PROCESSING",
        stage: "CREATE",
        attempts,
        maxAttempts,
    });
}

/** The worker's three CAS writes: reclaim, claim, finish. */
function armClaim() {
    mockedJob.updateMany.mockResolvedValue({ count: 1 });
}

beforeEach(() => {
    jest.clearAllMocks();
    armClaim();
});

/* ==========================================
 * S4 — SUCCESS
 * ========================================== */

describe("S4 — a successful worker run finishes the job", () => {
    test("the shipment is created, the job goes DONE and the pickup slot is stored", async () => {
        armJob();
        mockedOrder.findUnique.mockResolvedValue(order());
        mockedCreateShipment.mockResolvedValue({
            ok: true,
            changed: true,
            shipmentStatus: "CREATED",
            shippingPaymentStatus: "NOT_APPLICABLE",
            pickupSchedule: {
                date: "2026-10-15",
                time: "09:00-12:00",
            },
        });

        const result = await processShipmentJobs({ limit: 5 });

        expect(result.processed).toBe(1);
        expect(mockedCreateShipment).toHaveBeenCalledWith(
            ORDER_ID
        );

        // The job is DONE, with no error and the resolved pickup slot.
        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: JOB_ID, status: "PROCESSING" },
                data: expect.objectContaining({
                    status: "DONE",
                    lastError: null,
                    pickupDate: "2026-10-15",
                    pickupTime: "09:00-12:00",
                }),
            })
        );

        // No payment step is scheduled for a successful COD create.
        expect(mockedPayShipment).not.toHaveBeenCalled();
    });

    test("a flagged COD order (review PENDING) reaches the same successful outcome", async () => {
        armJob();
        mockedOrder.findUnique.mockResolvedValue(
            order({
                requiresCodReview: true,
                codReviewStatus: "PENDING",
            })
        );
        mockedCreateShipment.mockResolvedValue({
            ok: true,
            changed: true,
            shipmentStatus: "CREATED",
            shippingPaymentStatus: "NOT_APPLICABLE",
        });

        await processShipmentJobs({ limit: 5 });

        expect(mockedCreateShipment).toHaveBeenCalledWith(
            ORDER_ID
        );
        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "DONE",
                }),
            })
        );
    });

    test("an order waiting for shipping payment moves the job to the PAY stage", async () => {
        armJob();
        mockedOrder.findUnique.mockResolvedValue(order());
        mockedCreateShipment.mockResolvedValue({
            ok: true,
            changed: true,
            shipmentStatus: "WAITING_SHIPPING_PAYMENT",
            shippingPaymentStatus: "UNPAID",
        });

        await processShipmentJobs({ limit: 5 });

        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    stage: "PAY",
                    status: "PENDING",
                }),
            })
        );
    });
});

/* ==========================================
 * S5 — FAILURE IS RECORDED, NEVER SILENT
 * ========================================== */

describe("S5 — a worker failure is recorded on the job", () => {
    test("a provider refusal is retried with a durable reason", async () => {
        armJob(1, 6);
        mockedOrder.findUnique.mockResolvedValue(order());
        mockedCreateShipment.mockResolvedValue({
            ok: false,
            reason: "Kuota pickup Mengantar penuh.",
        });

        await processShipmentJobs({ limit: 5 });

        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: JOB_ID, status: "PROCESSING" },
                data: expect.objectContaining({
                    status: "PENDING",
                    lastError: "Kuota pickup Mengantar penuh.",
                    lockedAt: null,
                    nextAttemptAt: expect.any(Date),
                }),
            })
        );
    });

    test("a THROWN provider error is caught and recorded too", async () => {
        armJob(2, 6);
        mockedOrder.findUnique.mockResolvedValue(order());
        mockedCreateShipment.mockRejectedValue(
            new Error("MENGANTAR TIMEOUT")
        );

        await processShipmentJobs({ limit: 5 });

        /* The sweep must never reject: the failure is in the job row. */
        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "PENDING",
                    lastError: "MENGANTAR TIMEOUT",
                }),
            })
        );
    });

    test("the attempt budget is spent → the job FAILS with the last error", async () => {
        armJob(6, 6);
        mockedOrder.findUnique.mockResolvedValue(order());
        mockedCreateShipment.mockResolvedValue({
            ok: false,
            reason: "Provider menolak permanen.",
        });

        await processShipmentJobs({ limit: 5 });

        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: JOB_ID, status: "PROCESSING" },
                data: expect.objectContaining({
                    status: "FAILED",
                    lastError: "Provider menolak permanen.",
                }),
            })
        );
    });
});

/* ==========================================
 * S6 — NO DUPLICATE SHIPMENT
 * ========================================== */

describe("S6 — repeated processing never creates a second shipment", () => {
    test("a second sweep finds no due job and calls the provider only once", async () => {
        armJob();
        mockedOrder.findUnique.mockResolvedValue(order());
        mockedCreateShipment.mockResolvedValue({
            ok: true,
            changed: true,
            shipmentStatus: "CREATED",
            shippingPaymentStatus: "NOT_APPLICABLE",
        });

        await processShipmentJobs({ limit: 5 });

        // The job is no longer PENDING, so the next sweep sees nothing.
        mockedJob.findMany.mockResolvedValue([]);

        const second = await processShipmentJobs({ limit: 5 });

        expect(second.processed).toBe(0);
        expect(mockedCreateShipment).toHaveBeenCalledTimes(1);
    });

    test("losing the claim race means the provider is never called", async () => {
        armJob();
        mockedOrder.findUnique.mockResolvedValue(order());
        mockedCreateShipment.mockResolvedValue({
            ok: true,
            changed: true,
            shipmentStatus: "CREATED",
            shippingPaymentStatus: "NOT_APPLICABLE",
        });

        // reclaim → 0, claim → 0 (another worker already took it)
        mockedJob.updateMany
            .mockResolvedValueOnce({ count: 0 })
            .mockResolvedValueOnce({ count: 0 });

        const result = await processShipmentJobs({ limit: 5 });

        expect(result.processed).toBe(0);
        expect(mockedCreateShipment).not.toHaveBeenCalled();
    });

    test("two concurrent sweeps call the provider exactly once", async () => {
        /*
         * Both sweeps see the same due job; the CAS lets only one claim
         * it, which is what keeps "one job → one shipment" true even
         * when the cron and the post-response nudge overlap.
         */
        armJob();
        mockedOrder.findUnique.mockResolvedValue(order());
        mockedCreateShipment.mockResolvedValue({
            ok: true,
            changed: true,
            shipmentStatus: "CREATED",
            shippingPaymentStatus: "NOT_APPLICABLE",
        });

        let claimServed = false;

        mockedJob.updateMany.mockImplementation(
            async (args: {
                where?: { id?: number; status?: string };
                data?: { status?: string };
            }) => {
                // reclaim pass
                if (args?.data?.status === "PENDING" && !args?.where?.id) {
                    return { count: 0 };
                }

                // claim pass
                if (args?.data?.status === "PROCESSING") {
                    if (claimServed) return { count: 0 };
                    claimServed = true;
                    return { count: 1 };
                }

                return { count: 1 };
            }
        );

        const [a, b] = await Promise.all([
            processShipmentJobs({ limit: 5 }),
            processShipmentJobs({ limit: 5 }),
        ]);

        expect(a.processed + b.processed).toBe(1);
        expect(mockedCreateShipment).toHaveBeenCalledTimes(1);
    });
});

/* ==========================================
 * S8 — NON-MENGANTAR IS NEVER SENT TO MENGANTAR
 * ========================================== */

describe("S8 — a non-Mengantar order never becomes a Mengantar shipment", () => {
    test("the worker retires the job without calling the provider", async () => {
        armJob();
        mockedOrder.findUnique.mockResolvedValue(
            order({ shippingProvider: null })
        );

        await processShipmentJobs({ limit: 5 });

        expect(mockedCreateShipment).not.toHaveBeenCalled();
        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: JOB_ID, status: "PROCESSING" },
                data: expect.objectContaining({
                    status: "CANCELLED",
                }),
            })
        );
    });
});
