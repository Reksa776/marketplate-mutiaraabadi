/**
 * ==========================================
 * MENGANTAR SHIPMENT SELF-HEALING
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-reconcile.test.ts
 *
 * Scenario: an order is locally CREATED (providerShipmentId +
 * trackingNumber + ShipmentJob DONE) but the shipment was deleted on
 * the Mengantar dashboard. Local guards ("already created") then
 * block automatic shipping forever.
 *
 * Fix: when the provider AUTHORITATIVELY confirms the shipment is
 * gone, reset the order atomically to SHIPMENT_PENDING and re-queue
 * the durable ShipmentJob so the existing worker creates a new one.
 *
 * The provider is fully MOCKED — no request reaches Mengantar, and
 * no production shipment is created.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

/* ==========================================
 * MOCKS
 * ========================================== */

const mockOrder = {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
};

const mockShipmentJob = {
    updateMany: jest.fn(),
    createMany: jest.fn(),
};

const mockAuditLog = {
    create: jest.fn(),
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
        shipmentJob: mockShipmentJob,
        adminAuditLog: mockAuditLog,
        orderItem: { findMany: jest.fn() },
    },
}));

jest.mock("@/lib/mengantar", () => ({
    MengantarError: class MengantarError extends Error {
        status?: number;
        code?: string;
    },
    getMengantarOrderByTracking: jest.fn(),
    getMengantarOrderByOrderId: jest.fn(),
    createMengantarOrder: jest.fn(),
    estimateMengantarShipping: jest.fn(),
    payMengantarUnpaid: jest.fn(),
    toInternalCourier: (name: string) =>
        String(name).toLowerCase(),
    toMengantarCourier: (code: unknown) =>
        String(code ?? "").toLowerCase() === "jne"
            ? "JNE"
            : null,
    redactMengantarKey: (value: unknown) =>
        String(value ?? ""),
}));

jest.mock("@/lib/mengantar/shipping", () => ({
    getMengantarOriginConfig: jest.fn(),
    resolveMengantarDestinationAreaId: jest.fn(),
}));

// The worker sweep is not under test here; the cron route only needs
// to call it.
jest.mock("@/lib/mengantar/shipment-worker", () => ({
    processShipmentJobs: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import {
    createMengantarOrder,
    getMengantarOrderByTracking,
    getMengantarOrderByOrderId,
} from "@/lib/mengantar";
import {
    getMengantarOriginConfig,
    resolveMengantarDestinationAreaId,
} from "@/lib/mengantar/shipping";
import { processShipmentJobs } from "@/lib/mengantar/shipment-worker";

import {
    classifyMengantarLookup,
    classifyMengantarTrackingLookup,
    classifyMengantarLookupError,
    reconcileMengantarShipment,
    reconcileMengantarShipments,
    verifyMengantarShipment,
} from "@/lib/mengantar/reconcile";
import { createShipmentForOrder } from "@/lib/mengantar/shipment";

import {
    GET as cronGET,
    POST as cronPOST,
} from "@/app/api/cron/shipment-reconcile/route";

const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
};
const mockedJob = prisma.shipmentJob as unknown as {
    updateMany: jest.Mock;
    createMany: jest.Mock;
};
const mockedAudit = (
    prisma as unknown as {
        adminAuditLog: { create: jest.Mock };
    }
).adminAuditLog;
const mockedLookup =
    getMengantarOrderByOrderId as unknown as jest.Mock;
const mockedTrackingLookup =
    getMengantarOrderByTracking as unknown as jest.Mock;
const mockedCreateOrder =
    createMengantarOrder as unknown as jest.Mock;
const mockedOrigin =
    getMengantarOriginConfig as unknown as jest.Mock;
const mockedResolveDestination =
    resolveMengantarDestinationAreaId as unknown as jest.Mock;
const mockedProcessJobs =
    processShipmentJobs as unknown as jest.Mock;

function readFile(relativePath: string): string {
    try {
        return readFileSync(
            resolve(process.cwd(), relativePath),
            "utf-8"
        );
    } catch {
        return "";
    }
}

/* ==========================================
 * FIXTURES
 * ========================================== */

const ORDER_ID = "260130OVBBOO";

function createdOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 963,
        providerShipmentId: ORDER_ID,
        trackingNumber: "JO0328436240",
        shipmentStatus: "CREATED",
        shippingProvider: "MENGANTAR",
        paymentStatus: "PAID",
        paymentMethod: "BANK_TRANSFER",
        status: "PAID",
        ...overrides,
    };
}

function resetCall() {
    return mockedOrder.updateMany.mock.calls.find(
        (call) =>
            (call[0] as { data?: { shipmentStatus?: string } })
                .data?.shipmentStatus === "SHIPMENT_PENDING"
    );
}

function baseOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 963,
        orderNumber: "PAY-BN-963",
        status: "PAID",
        recipientName: "Budi",
        phone: "081234567890",
        address: "Jl. Contoh No. 1",
        province: "DKI JAKARTA",
        city: "JAKARTA SELATAN",
        district: "KEBAYORAN BARU",
        postalCode: "12120",
        paymentMethod: "BANK_TRANSFER",
        paymentStatus: "PAID",
        shippingProvider: "MENGANTAR",
        providerCourier: "jne",
        providerShipmentId: null,
        providerBatchId: null,
        shipmentStatus: "SHIPMENT_PENDING",
        shippingPaymentStatus: null,
        trackingNumber: null,
        total: 110000,
        shippingCost: 10000,
        codAmount: null,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();

    delete process.env.CRON_SECRET;

    (prisma as unknown as {
        orderItem: { findMany: jest.Mock };
    }).orderItem.findMany.mockResolvedValue([
        {
            productName: "Kaos",
            variantName: "L",
            quantity: 1,
            variant: { weight: 1000 },
        },
    ]);

    mockedOrigin.mockResolvedValue({
        originAreaId: "origin-area",
        pickupAddressId: "pickup-addr",
        pickupTimeId: null,
    });
    mockedResolveDestination.mockResolvedValue("dest-area");

    mockedOrder.updateMany.mockResolvedValue({ count: 1 });
    mockedJob.updateMany.mockResolvedValue({ count: 1 });
    mockedJob.createMany.mockResolvedValue({ count: 0 });
    mockedProcessJobs.mockResolvedValue({ processed: 0 });

    // Deterministic provider defaults per test.
    mockedLookup.mockResolvedValue(null);
    mockedTrackingLookup.mockResolvedValue(null);
});

/* ==========================================
 * PURE CLASSIFICATION
 * ========================================== */

describe("provider lookup classification", () => {
    it("missing for an empty authoritative (order_id) result", () => {
        expect(classifyMengantarLookup(null)).toBe("missing");
    });

    it("exists whenever the authoritative lookup returns a row", () => {
        expect(classifyMengantarLookup({})).toBe("exists");
    });

    it("DELETED when the provider explicitly flags the order isDeleted", () => {
        expect(
            classifyMengantarLookup({ isDeleted: true })
        ).toBe("deleted");
    });

    it("a stale resi alone is NOT authoritative (tracking-only)", () => {
        // Empty tracking result must never be treated as missing…
        expect(classifyMengantarTrackingLookup(null)).toBe(
            "uncertain"
        );
        // …but a returned row, or an explicit deletion, is decisive.
        expect(classifyMengantarTrackingLookup({})).toBe(
            "exists"
        );
        expect(
            classifyMengantarTrackingLookup({
                isDeleted: true,
            })
        ).toBe("deleted");
    });

    it("only a 404 error means confirmed-missing", () => {
        expect(
            classifyMengantarLookupError({ status: 404 })
        ).toBe("missing");

        for (const error of [
            { status: 401 },
            { status: 403 },
            { status: 429 },
            { status: 500 },
            { status: 503 },
            new Error("timeout"),
            { name: "AbortError" },
            null,
        ]) {
            expect(
                classifyMengantarLookupError(error)
            ).toBe("uncertain");
        }
    });
});

/* ==========================================
 * 1-9, 11. RECONCILE ONE ORDER
 * ========================================== */

describe("reconcileMengantarShipment", () => {
    it("1. provider still exists → no reset, no job", async () => {
        mockedLookup.mockResolvedValue({
            orderId: ORDER_ID,
        });

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.verdict).toBe("exists");
        expect(result.reconciled).toBe(false);
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
    });

    it("9. provider exists after reconciliation → never duplicates", async () => {
        mockedLookup.mockResolvedValue({
            orderId: ORDER_ID,
        });

        await reconcileMengantarShipment(createdOrder());
        await reconcileMengantarShipment(createdOrder());

        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("2. provider confirmed missing → reset + enqueue", async () => {
        mockedLookup.mockResolvedValue(null);

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.verdict).toBe("missing");
        expect(result.reconciled).toBe(true);

        const call = resetCall();
        expect(call).toBeTruthy();
        expect(call![0].data).toEqual(
            expect.objectContaining({
                shipmentStatus: "SHIPMENT_PENDING",
                providerShipmentId: null,
                providerBatchId: null,
                trackingNumber: null,
            })
        );

        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    orderId: 963,
                }),
                data: expect.objectContaining({
                    status: "PENDING",
                    stage: "CREATE",
                    attempts: 0,
                }),
            })
        );
    });

    it("2b. an empty provider result is confirmed missing", async () => {
        mockedLookup.mockResolvedValue(null);

        const result = await reconcileMengantarShipment(
            createdOrder()
        );
        expect(result.reconciled).toBe(true);
    });

    it("3. provider 500 → NEVER reset", async () => {
        mockedLookup.mockRejectedValue({ status: 500 });

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.verdict).toBe("uncertain");
        expect(result.reconciled).toBe(false);
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
    });

    it("4. provider timeout → NEVER reset", async () => {
        mockedLookup.mockRejectedValue(
            Object.assign(new Error("aborted"), {
                name: "AbortError",
            })
        );

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.verdict).toBe("uncertain");
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
    });

    it("4b. provider network error → NEVER reset", async () => {
        mockedLookup.mockRejectedValue(
            Object.assign(new TypeError("fetch failed"), {
                category: "UPSTREAM_NETWORK_ERROR",
            })
        );

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.verdict).toBe("uncertain");
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
    });

    it("5. provider 401 → NEVER reset", async () => {
        mockedLookup.mockRejectedValue({ status: 401 });

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.verdict).toBe("uncertain");
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
    });

    it("5b. provider 403 / 429 → NEVER reset", async () => {
        for (const status of [403, 429]) {
            mockedOrder.updateMany.mockClear();
            mockedLookup.mockRejectedValue({ status });

            const result = await reconcileMengantarShipment(
                createdOrder()
            );

            expect(result.verdict).toBe("uncertain");
            expect(
                mockedOrder.updateMany
            ).not.toHaveBeenCalled();
        }
    });

    it("6. provider 404 but order not PAID → no create", async () => {
        mockedLookup.mockResolvedValue(null);
        // CAS fails because the WHERE clause requires PAID.
        mockedOrder.updateMany.mockResolvedValue({ count: 0 });

        const result = await reconcileMengantarShipment(
            createdOrder({ paymentStatus: "UNPAID" })
        );

        expect(result.reconciled).toBe(false);
        // The hard preconditions are enforced in the atomic WHERE.
        const where = mockedOrder.updateMany.mock.calls[0][0]
            .where;
        expect(where).toEqual(
            expect.objectContaining({
                paymentStatus: "PAID",
                shipmentStatus: "CREATED",
                providerShipmentId: ORDER_ID,
            })
        );
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("7. provider 404 but order is COD → no create", async () => {
        mockedLookup.mockResolvedValue(null);
        mockedOrder.updateMany.mockResolvedValue({ count: 0 });

        const result = await reconcileMengantarShipment(
            createdOrder({ paymentMethod: "COD" })
        );

        expect(result.reconciled).toBe(false);

        const where = mockedOrder.updateMany.mock.calls[0][0]
            .where;
        expect(where).toEqual(
            expect.objectContaining({
                paymentMethod: { not: "COD" },
                status: { not: "CANCELLED" },
            })
        );
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
    });

    it("8. a concurrent reconciler that loses the CAS never enqueues", async () => {
        mockedLookup.mockResolvedValue(null);
        mockedOrder.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });

        const [first, second] = await Promise.all([
            reconcileMengantarShipment(createdOrder()),
            reconcileMengantarShipment(createdOrder()),
        ]);

        // Exactly one winner.
        const winners = [first, second].filter(
            (r) => r.reconciled
        );
        expect(winners).toHaveLength(1);
        expect(mockedJob.updateMany).toHaveBeenCalledTimes(1);
    });

    it("creates a missing job row when none exists", async () => {
        mockedLookup.mockResolvedValue(null);
        mockedJob.updateMany.mockResolvedValue({ count: 0 });

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.reconciled).toBe(true);
        expect(mockedJob.createMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: [{ orderId: 963 }],
                skipDuplicates: true,
            })
        );
    });

    it("verifies via providerShipmentId even when the resi is missing", async () => {
        mockedLookup.mockResolvedValue({});

        const result = await verifyMengantarShipment({
            providerShipmentId: ORDER_ID,
            trackingNumber: null,
        });

        expect(result).toBe("exists");
        expect(mockedLookup).toHaveBeenCalledWith(ORDER_ID);
    });

    it("a stale resi that returns empty is NOT treated as missing", async () => {
        // No providerShipmentId → tracking fallback → empty → uncertain.
        mockedTrackingLookup.mockResolvedValue(null);

        const result = await verifyMengantarShipment({
            providerShipmentId: null,
            trackingNumber: "JO0123456789",
        });

        expect(result).toBe("uncertain");
        expect(mockedLookup).not.toHaveBeenCalled();
        expect(mockedTrackingLookup).toHaveBeenCalledWith(
            "JO0123456789"
        );
    });

    it("a tracking row marked isDeleted IS confirmed deleted", async () => {
        mockedTrackingLookup.mockResolvedValue({
            isDeleted: true,
        });

        const result = await verifyMengantarShipment({
            providerShipmentId: null,
            trackingNumber: "JO0123456789",
        });

        expect(result).toBe("deleted");
    });

    it("prefers providerShipmentId over the resi", async () => {
        mockedLookup.mockResolvedValue({});

        await verifyMengantarShipment({
            providerShipmentId: ORDER_ID,
            trackingNumber: "JO0328436240",
        });

        expect(mockedLookup).toHaveBeenCalledWith(ORDER_ID);
        expect(mockedTrackingLookup).not.toHaveBeenCalled();
    });

    it("cannot verify without any provider identifier", async () => {
        const result = await verifyMengantarShipment({
            providerShipmentId: null,
            trackingNumber: null,
        });

        expect(result).toBe("uncertain");
        expect(mockedLookup).not.toHaveBeenCalled();
        expect(mockedTrackingLookup).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * SCAN (sweep)
 * ========================================== */

describe("reconcileMengantarShipments", () => {
    it("scans only paid, non-COD, CREATED Mengantar orders", async () => {
        mockedOrder.findMany.mockResolvedValue([
            {
                id: 963,
                providerShipmentId: ORDER_ID,
                trackingNumber: "JO0328436240",
                shipmentStatus: "CREATED",
            },
        ]);
        mockedLookup.mockResolvedValue(null);

        const result = await reconcileMengantarShipments({
            limit: 25,
        });

        expect(result.scanned).toBe(1);
        expect(result.reconciled).toBe(1);

        const where = mockedOrder.findMany.mock.calls[0][0].where;
        expect(where).toEqual(
            expect.objectContaining({
                shippingProvider: "MENGANTAR",
                shipmentStatus: "CREATED",
                paymentStatus: "PAID",
                paymentMethod: { not: "COD" },
                status: { not: "CANCELLED" },
            })
        );
        // Only shipments stable for a while are eligible.
        expect(where.updatedAt.lt).toBeInstanceOf(Date);
    });

    it("isolates a failing order so the sweep continues", async () => {
        mockedOrder.findMany.mockResolvedValue([
            {
                id: 1,
                providerShipmentId: "A",
                trackingNumber: "R1",
                shipmentStatus: "CREATED",
            },
            {
                id: 2,
                providerShipmentId: "B",
                trackingNumber: "R2",
                shipmentStatus: "CREATED",
            },
        ]);

        mockedLookup
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValueOnce(null);

        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const result = await reconcileMengantarShipments();

        expect(result.scanned).toBe(2);
        expect(result.reconciled).toBe(1);

        errorSpy.mockRestore();
    });
});

/* ==========================================
 * 10, 11. CREATE AFTER RESET
 * ========================================== */

describe("create after self-healing reset", () => {
    it("11. a new provider shipment persists the NEW ORDER_ID", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            baseOrder({
                shipmentStatus: "SHIPMENT_PENDING",
                providerShipmentId: null,
            })
        );
        mockedCreateOrder.mockResolvedValue({
            data: [
                {
                    ORDER_ID: "NEW-ORDER-1",
                    batch_id: "NEW-BATCH",
                    cnote_no: "NEW-CNOTE",
                    isPaid: true,
                    error: null,
                },
            ],
            batch_id: "NEW-BATCH",
        });

        const result = await createShipmentForOrder(963);

        expect(result.ok).toBe(true);
        expect(result.shipmentId).toBe("NEW-ORDER-1");

        const finalize =
            mockedOrder.updateMany.mock.calls[1][0];
        expect(finalize.data.providerShipmentId).toBe(
            "NEW-ORDER-1"
        );
        expect(finalize.data.trackingNumber).toBe(
            "NEW-CNOTE"
        );
        expect(finalize.data.shipmentStatus).toBe("CREATED");
    });

    it("11b. external deletion → recreate persists the NEW id + resi", async () => {
        // 1) reconcile clears the stale provider identifiers.
        mockedLookup.mockResolvedValue({ isDeleted: true });
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });
        mockedJob.updateMany.mockResolvedValue({ count: 1 });

        const reconcile = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(reconcile.action).toBe("recreated");

        // 2) the worker then creates a fresh shipment.
        mockedOrder.findUnique.mockResolvedValue(
            baseOrder({
                shipmentStatus: "SHIPMENT_PENDING",
                providerShipmentId: null,
            })
        );
        mockedCreateOrder.mockResolvedValue({
            data: [
                {
                    ORDER_ID: "FRESH-ORDER-2",
                    batch_id: "FRESH-BATCH",
                    cnote_no: "FRESH-CNOTE",
                    isPaid: true,
                    error: null,
                },
            ],
            batch_id: "FRESH-BATCH",
        });

        const created = await createShipmentForOrder(963);

        expect(created.ok).toBe(true);
        expect(created.shipmentId).toBe("FRESH-ORDER-2");
        expect(created.trackingNumber).toBe("FRESH-CNOTE");
        expect(created.shipmentStatus).toBe("CREATED");
    });

    it("8b. a losing worker cannot POST a duplicate provider order", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            baseOrder({
                shipmentStatus: "SHIPMENT_PENDING",
                providerShipmentId: null,
            })
        );
        // The atomic claim returns 0 → another worker won.
        mockedOrder.updateMany.mockResolvedValue({ count: 0 });

        const result = await createShipmentForOrder(963);

        expect(result.ok).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("10. provider POST success + finalize miss → ORDER_ID backfilled (no second POST)", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            baseOrder({
                shipmentStatus: "SHIPMENT_PENDING",
                providerShipmentId: null,
            })
        );
        mockedCreateOrder.mockResolvedValue({
            data: [
                {
                    ORDER_ID: "NEW-ORDER-1",
                    batch_id: "NEW-BATCH",
                    cnote_no: "NEW-CNOTE",
                    isPaid: true,
                    error: null,
                },
            ],
            batch_id: "NEW-BATCH",
        });

        mockedOrder.updateMany
            .mockResolvedValueOnce({ count: 1 }) // claim
            .mockResolvedValueOnce({ count: 0 }) // finalize CAS miss
            .mockResolvedValueOnce({ count: 1 }); // recovery

        const result = await createShipmentForOrder(963);

        expect(result.ok).toBe(true);
        expect(mockedCreateOrder).toHaveBeenCalledTimes(1);
        expect(
            mockedOrder.updateMany
        ).toHaveBeenCalledTimes(3);

        const recovery =
            mockedOrder.updateMany.mock.calls[2][0];
        expect(recovery.where).toEqual(
            expect.objectContaining({
                providerShipmentId: null,
            })
        );
        expect(recovery.data.providerShipmentId).toBe(
            "NEW-ORDER-1"
        );
    });
});

/* ==========================================
 * CRON ENDPOINT
 * ========================================== */

describe("GET /api/cron/shipment-reconcile", () => {
    const SECRET = "cron-secret-DO-NOT-LEAK";

    function request(headers: Record<string, string> = {}) {
        return new Request(
            "http://test/api/cron/shipment-reconcile",
            { headers }
        );
    }

    it("fails closed (503) when CRON_SECRET is unset", async () => {
        delete process.env.CRON_SECRET;

        const response = (await cronGET(
            request()
        )) as Response;

        expect(response.status).toBe(503);
        expect(mockedProcessJobs).not.toHaveBeenCalled();
    });

    it("401 for a wrong secret", async () => {
        process.env.CRON_SECRET = SECRET;

        const response = (await cronGET(
            request({ authorization: "Bearer nope" })
        )) as Response;

        expect(response.status).toBe(401);
        expect(mockedProcessJobs).not.toHaveBeenCalled();
    });

    it("runs reconcile + the worker sweep with the right secret", async () => {
        process.env.CRON_SECRET = SECRET;
        mockedOrder.findMany.mockResolvedValue([]);
        mockedProcessJobs.mockResolvedValue({
            processed: 3,
        });

        const response = (await cronGET(
            request({ authorization: `Bearer ${SECRET}` })
        )) as Response;
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data.processed).toBe(3);
        expect(mockedProcessJobs).toHaveBeenCalled();

        delete process.env.CRON_SECRET;
    });

    it("accepts the x-cron-secret header", async () => {
        process.env.CRON_SECRET = SECRET;
        mockedOrder.findMany.mockResolvedValue([]);

        const response = (await cronGET(
            request({ "x-cron-secret": SECRET })
        )) as Response;

        expect(response.status).toBe(200);

        delete process.env.CRON_SECRET;
    });

    it("never returns the secret", async () => {
        process.env.CRON_SECRET = SECRET;
        mockedOrder.findMany.mockResolvedValue([]);

        const response = (await cronGET(
            request({ authorization: `Bearer ${SECRET}` })
        )) as Response;

        const serialized = JSON.stringify(
            await response.json()
        );
        expect(serialized).not.toContain(SECRET);

        delete process.env.CRON_SECRET;
    });

    it("POST is accepted (schedulers may use either method)", async () => {
        process.env.CRON_SECRET = SECRET;
        mockedOrder.findMany.mockResolvedValue([]);

        const response = (await cronPOST(
            new Request(
                "http://test/api/cron/shipment-reconcile",
                {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${SECRET}`,
                    },
                }
            )
        )) as Response;

        expect(response.status).toBe(200);
        expect(mockedProcessJobs).toHaveBeenCalledTimes(1);

        delete process.env.CRON_SECRET;
    });

    it("POST without a secret is rejected (401), not served", async () => {
        process.env.CRON_SECRET = SECRET;

        const headersList: Array<
            Record<string, string>
        > = [
            {},
            { authorization: "Bearer " },
            { authorization: "Bearer wrong" },
            { "x-cron-secret": "wrong" },
        ];

        for (const headers of headersList) {
            const response = (await cronPOST(
                new Request(
                    "http://test/api/cron/shipment-reconcile",
                    { method: "POST", headers }
                )
            )) as Response;

            expect(response.status).toBe(401);
        }

        expect(mockedProcessJobs).not.toHaveBeenCalled();

        delete process.env.CRON_SECRET;
    });

    it("both methods fail closed (503) with no CRON_SECRET", async () => {
        delete process.env.CRON_SECRET;

        const get = (await cronGET(request())) as Response;
        const post = (await cronPOST(
            new Request(
                "http://test/api/cron/shipment-reconcile",
                { method: "POST" }
            )
        )) as Response;

        expect(get.status).toBe(503);
        expect(post.status).toBe(503);
        expect(mockedProcessJobs).not.toHaveBeenCalled();
    });

    it("a non-empty CRON_SECRET of a different length is still rejected", async () => {
        process.env.CRON_SECRET = SECRET;

        const response = (await cronGET(
            request({
                authorization: `Bearer ${SECRET}-longer`,
            })
        )) as Response;

        expect(response.status).toBe(401);

        delete process.env.CRON_SECRET;
    });
});

/* ==========================================
 * NO PROVIDER WRITE UNTIL CONFIRMED MISSING
 * ========================================== */

describe("reconciliation never POSTs to Mengantar first", () => {
    it("only issues a provider GET; never a create POST", async () => {
        mockedOrder.findMany.mockResolvedValue([
            {
                id: 963,
                providerShipmentId: ORDER_ID,
                trackingNumber: "JO0328436240",
                shipmentStatus: "CREATED",
            },
        ]);
        // Provider still HAS the shipment → must not reset, and must
        // never call createMengantarOrder (POST /order).
        mockedLookup.mockResolvedValue({ orderId: ORDER_ID });

        await reconcileMengantarShipments({ limit: 25 });

        // Read-only verification happened…
        expect(mockedLookup).toHaveBeenCalledWith(ORDER_ID);
        // …and NOTHING was enqueued or created.
        expect(mockedCreateOrder).not.toHaveBeenCalled();
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
    });

    it("a confirmed-missing order is enqueued but still not POSTed by reconcile itself", async () => {
        mockedOrder.findMany.mockResolvedValue([
            {
                id: 963,
                providerShipmentId: ORDER_ID,
                trackingNumber: "JO0328436240",
                shipmentStatus: "CREATED",
            },
        ]);
        mockedLookup.mockResolvedValue(null);

        await reconcileMengantarShipments({ limit: 25 });

        // Reconcile only queues the durable job — it never calls the
        // provider's create endpoint. The worker does that later,
        // behind its CAS claim.
        expect(mockedCreateOrder).not.toHaveBeenCalled();
        expect(mockedJob.updateMany).toHaveBeenCalled();
    });

    it("never verifies with a POST-capable client (GET only)", () => {
        const code = readFile("lib/mengantar/reconcile.ts");

        expect(code).toContain(
            "getMengantarOrderByOrderId"
        );
        expect(code).toContain(
            "getMengantarOrderByTracking"
        );
        expect(code).not.toContain("createMengantarOrder");
        expect(code).not.toContain("payMengantarUnpaid");
        expect(code).not.toContain('method: "POST"');
    });

    it("the provider lookup helper is a GET on /order", () => {
        const code = readFile("lib/mengantar.ts");
        const start = code.indexOf(
            "async function lookupMengantarOrder"
        );
        const slice = code.slice(start, start + 700);

        expect(slice).toContain('method: "GET"');
        expect(slice).toContain("/order?");
        // Both lookup filters are documented provider query params.
        expect(code).toContain('params.set("order_id", orderId)');
        expect(code).toContain(
            'params.set("tracking_id", trackingNumber)'
        );
    });
});

/* ==========================================
 * EDGE / PROXY REACHABILITY
 * ========================================== */

describe("scheduler reachability + guards", () => {
    it("the auth proxy does not block /api/cron (handler owns the secret)", () => {
        const code = readFile("proxy.ts");

        // If /api/cron were in the PROTECTED list a scheduler without a
        // session cookie could never reach it.
        expect(code).not.toMatch(
            /PROTECTED_API_PREFIXES[\s\S]*?"\/api\/cron/
        );
        // It is also not claimed as public-without-secret.
        expect(code).not.toMatch(
            /PUBLIC_API_PREFIXES[\s\S]*?"\/api\/cron/
        );
    });

    it("the cron route validates the secret before doing any work", () => {
        const code = readFile(
            "app/api/cron/shipment-reconcile/route.ts"
        );

        const guardIndex = code.indexOf(
            "if (!isAuthorized(request))"
        );
        const workIndex = code.indexOf(
            "await reconcileMengantarShipments({"
        );

        expect(guardIndex).toBeGreaterThan(-1);
        expect(workIndex).toBeGreaterThan(-1);
        expect(guardIndex).toBeLessThan(workIndex);
    });
});

/* ==========================================
 * 12-16. UI + SOURCE GUARDS
 * ========================================== */

describe("realtime UI + guards", () => {
    const adminPage = readFile(
        "app/admin/orders/[id]/page.tsx"
    );

    it("12/13. polls only transient shipment states with exponential backoff", () => {
        expect(adminPage).toContain(
            "TRANSIENT_SHIPMENT_STATUSES"
        );
        expect(adminPage).toContain('"SHIPMENT_PENDING"');
        expect(adminPage).toContain('"CREATING"');
        expect(adminPage).toContain('"PAYING"');
        expect(adminPage).toContain(
            "SHIPMENT_POLL_BASE_MS"
        );
        expect(adminPage).toContain("SHIPMENT_POLL_MAX_MS");
        expect(adminPage).toContain("15000");

        // Stop condition: settled statuses are not in the transient set.
        expect(adminPage).not.toMatch(
            /TRANSIENT_SHIPMENT_STATUSES[\s\S]{0,200}"CREATED"/
        );
    });

    it("12b. polling reads the app API, never Mengantar directly", () => {
        expect(adminPage).toContain(
            "/api/admin/orders/${id}/shipment"
        );
        expect(adminPage).not.toContain(
            "api-public.mengantar.com"
        );
    });

    it("14. the admin page never receives a provider key", () => {
        expect(adminPage).not.toContain("MENGANTAR_API_KEY");
        expect(adminPage).not.toContain(
            "MENGANTAR_WEBHOOK_SECRET"
        );
        expect(adminPage).not.toContain("CRON_SECRET");
    });

    it("9. the shipment panel shows the fresh state, never the stale order fallback", () => {
        // `shipment?.providerShipmentId ?? order.providerShipmentId`
        // would re-show the OLD id after a reset nulled it.
        expect(adminPage).not.toMatch(
            /shipment\?\.providerShipmentId/
        );
        expect(adminPage).not.toMatch(
            /shipment\?\.providerBatchId/
        );
        expect(adminPage).not.toMatch(
            /shipment\?\.trackingNumber/
        );

        // Authoritative: the loaded shipment wins, order is fallback.
        expect(adminPage).toMatch(
            /shipment\s*\? shipment\.providerShipmentId\s*: order\.providerShipmentId/
        );
        expect(adminPage).toMatch(
            /shipment\s*\? shipment\.providerBatchId\s*: order\.providerBatchId/
        );
        expect(adminPage).toMatch(
            /shipment\s*\? shipment\.trackingNumber\s*: order\.trackingNumber/
        );
    });

    it("15. reconciliation never touches RajaOngkir", () => {
        const code = readFile("lib/mengantar/reconcile.ts");

        expect(code).not.toContain("rajaongkir");
        expect(code).not.toContain("@/lib/rajaongkir");
    });

    it("16. reconciliation never writes Order.paymentStatus", () => {
        const code = readFile("lib/mengantar/reconcile.ts");

        expect(code).toContain("paymentStatus: \"PAID\"");
        expect(code).not.toMatch(
            /data:\s*\{[^}]*paymentStatus/
        );
    });

    it("caps the cron route: fail-closed + timing-safe", () => {
        const code = readFile(
            "app/api/cron/shipment-reconcile/route.ts"
        );

        expect(code).toContain("timingSafeEqual");
        expect(code).toContain("CRON_SECRET");
        expect(code).toContain("503");
    });
});

/* ==========================================
 * HYBRID SELF-HEALING — INTENTIONAL DELETION
 * ==========================================
 *
 * isDeleted:true  → clear local state, NOT_CREATED, NEVER recreate.
 * missing (no flag) → anomaly → reset + re-queue + recreate.
 */

describe("hybrid self-healing — external deletion (recoverable)", () => {
    it("1. local CREATED + provider isDeleted → cleared + re-queued (NOT terminal)", async () => {
        mockedLookup.mockResolvedValue({ isDeleted: true });
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.verdict).toBe("deleted");
        expect(result.action).toBe("recreated");
        expect(result.reconciled).toBe(true);

        const call = mockedOrder.updateMany.mock.calls[0][0];
        expect(call.data).toEqual(
            expect.objectContaining({
                shipmentStatus: "SHIPMENT_PENDING",
                providerShipmentId: null,
                providerBatchId: null,
                trackingNumber: null,
            })
        );
        // External deletion must NEVER become a local terminal DELETED.
        expect(call.data.shipmentStatus).not.toBe("DELETED");

        // It IS recoverable: a job is re-queued for a fresh create.
        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "PENDING",
                }),
            })
        );

        // Reconcile itself NEVER POSTs — the worker owns creation.
        expect(mockedCreateOrder).not.toHaveBeenCalled();

        // Safe audit record.
        expect(mockedAudit.create).toHaveBeenCalledTimes(1);
        const audit = mockedAudit.create.mock.calls[0][0].data;
        expect(audit.action).toBe(
            "MENGANTAR_SHIPMENT_DELETED_EXTERNALLY"
        );
        expect(audit.entityId).toBe(963);
        expect(JSON.stringify(audit)).not.toMatch(
            /api[_-]?key|webhook|secret|token/i
        );
    });

    it("1-local. local DELETED + provider isDeleted → STOP, never recreate", async () => {
        mockedLookup.mockResolvedValue({ isDeleted: true });

        const result = await reconcileMengantarShipment(
            createdOrder({ shipmentStatus: "DELETED" })
        );

        expect(result.verdict).toBe("local_deleted");
        expect(result.reconciled).toBe(false);
        // The provider must not even be queried, and nothing re-queued.
        expect(mockedLookup).not.toHaveBeenCalled();
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.createMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("1-local-missing. local DELETED + provider missing → STOP, never recreate", async () => {
        mockedLookup.mockResolvedValue(null);

        const result = await reconcileMengantarShipment(
            createdOrder({ shipmentStatus: "DELETED" })
        );

        expect(result.verdict).toBe("local_deleted");
        expect(result.reconciled).toBe(false);
        expect(mockedLookup).not.toHaveBeenCalled();
        expect(mockedJob.createMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("1b. a lost CAS clears nothing, audits nothing, touches no job", async () => {
        mockedLookup.mockResolvedValue({ isDeleted: true });
        mockedOrder.updateMany.mockResolvedValue({ count: 0 });

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.reconciled).toBe(false);
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedAudit.create).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("5. AFTER deletion a later reconcile never recreates the shipment", async () => {
        // Post-deletion the ids are already cleared, so verification is
        // inconclusive (no identifier) → uncertain → strict no-op. This
        // is exactly why a cleared order can never be auto-recreated.
        const second = await reconcileMengantarShipment(
            createdOrder({
                shipmentStatus: "SHIPMENT_PENDING",
                providerShipmentId: null,
                trackingNumber: null,
            })
        );

        expect(second.reconciled).toBe(false);
        expect(second.verdict).toBe("uncertain");
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.createMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("5b. even an anomaly-missing on a NOT_CREATED order never re-queues", async () => {
        mockedLookup.mockResolvedValue(null);
        mockedOrder.updateMany.mockResolvedValue({ count: 0 });

        const result = await reconcileMengantarShipment(
            createdOrder({
                shipmentStatus: "NOT_CREATED",
                providerShipmentId: null,
                trackingNumber: null,
            })
        );

        expect(result.reconciled).toBe(false);
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.createMany).not.toHaveBeenCalled();
    });

    it("8. two concurrent external deletions → one reset, one job, no duplicate", async () => {
        mockedLookup.mockResolvedValue({ isDeleted: true });
        mockedOrder.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });

        const [a, b] = await Promise.all([
            reconcileMengantarShipment(createdOrder()),
            reconcileMengantarShipment(createdOrder()),
        ]);

        expect([a, b].filter((r) => r.reconciled)).toHaveLength(1);
        expect(mockedAudit.create).toHaveBeenCalledTimes(1);
        expect(mockedJob.updateMany).toHaveBeenCalledTimes(1);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });
});

describe("hybrid self-healing — unexpected missing (anomaly)", () => {
    it("2. missing without a deletion flag → recovery path + exactly one POST", async () => {
        // 1) reconcile detects the anomaly and re-queues (no POST yet).
        mockedLookup.mockResolvedValue(null);
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.verdict).toBe("missing");
        expect(result.action).toBe("recreated");
        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "PENDING",
                    stage: "CREATE",
                }),
            })
        );
        expect(mockedCreateOrder).not.toHaveBeenCalled();
        expect(mockedAudit.create).not.toHaveBeenCalled();

        // 2) the existing worker create path posts EXACTLY once.
        mockedOrder.findUnique.mockResolvedValue(
            baseOrder({
                shipmentStatus: "SHIPMENT_PENDING",
                providerShipmentId: null,
            })
        );
        mockedCreateOrder.mockResolvedValue({
            data: [
                {
                    ORDER_ID: "NEW-ORDER-1",
                    batch_id: "NEW-BATCH",
                    cnote_no: "NEW-CNOTE",
                    isPaid: true,
                    error: null,
                },
            ],
            batch_id: "NEW-BATCH",
        });
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });

        const created = await createShipmentForOrder(963);

        expect(created.ok).toBe(true);
        expect(created.shipmentId).toBe("NEW-ORDER-1");
        expect(created.trackingNumber).toBe("NEW-CNOTE");
        expect(mockedCreateOrder).toHaveBeenCalledTimes(1);
    });

    it("3. provider still has the shipment → no reset/job/POST/audit", async () => {
        mockedLookup.mockResolvedValue({ orderId: ORDER_ID });

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.verdict).toBe("exists");
        expect(result.reconciled).toBe(false);
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.createMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
        expect(mockedAudit.create).not.toHaveBeenCalled();
    });

    it("4. repeated reconcile of one missing shipment → one job, one POST", async () => {
        mockedLookup.mockResolvedValue(null);
        mockedOrder.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });

        const first = await reconcileMengantarShipment(
            createdOrder()
        );
        const second = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(first.reconciled).toBe(true);
        expect(second.reconciled).toBe(false);
        // Only the winner re-queues; the loser never touches jobs.
        expect(mockedJob.updateMany).toHaveBeenCalledTimes(1);
        expect(mockedJob.createMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });
});

describe("manual recovery + cancelled guard", () => {
    it("6. NOT_CREATED + PAID + MENGANTAR + non-COD → admin create succeeds", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            baseOrder({
                shipmentStatus: "NOT_CREATED",
                providerShipmentId: null,
                providerBatchId: null,
                trackingNumber: null,
            })
        );
        mockedCreateOrder.mockResolvedValue({
            data: [
                {
                    ORDER_ID: "NEW-ORDER-1",
                    batch_id: "NEW-BATCH",
                    cnote_no: "NEW-CNOTE",
                    isPaid: true,
                    error: null,
                },
            ],
            batch_id: "NEW-BATCH",
        });
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });

        const result = await createShipmentForOrder(963);

        expect(result.ok).toBe(true);
        expect(result.shipmentId).toBe("NEW-ORDER-1");
        expect(result.trackingNumber).toBe("NEW-CNOTE");

        const finalize = mockedOrder.updateMany.mock.calls[1][0];
        expect(finalize.data.providerShipmentId).toBe(
            "NEW-ORDER-1"
        );
        expect(finalize.data.trackingNumber).toBe("NEW-CNOTE");
    });

    it("6b. manual create is refused while an auto job still holds the claim", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            baseOrder({ shipmentStatus: "SHIPMENT_PENDING" })
        );
        mockedOrder.updateMany.mockResolvedValue({ count: 0 });

        const result = await createShipmentForOrder(963);

        expect(result.ok).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("7. a CANCELLED order is recoverable neither manually nor automatically", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            baseOrder({ status: "CANCELLED" })
        );

        const manual = await createShipmentForOrder(963);
        expect(manual.ok).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();

        mockedOrder.updateMany.mockResolvedValue({ count: 0 });
        mockedLookup.mockResolvedValue(null);

        const reconciled = await reconcileMengantarShipment(
            createdOrder({ status: "CANCELLED" })
        );

        expect(reconciled.reconciled).toBe(false);
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("7b. the reconcile source keeps the cancelled/COD/payment guards", () => {
        const code = readFile("lib/mengantar/reconcile.ts");

        expect(code).toContain('status: { not: "CANCELLED" }');
        expect(code).toContain('paymentMethod: { not: "COD" }');
        expect(code).toContain('paymentStatus: "PAID"');
    });

    it("7c. intentional deletion NEVER enqueues → no recreate safety source guard", () => {
        const code = readFile("lib/mengantar/reconcile.ts");

        // The deletion handler must cancel jobs, not create them.
        expect(code).toContain(
            "MENGANTAR_SHIPMENT_DELETED_EXTERNALLY"
        );
        // External deletion is RECOVERABLE — it resets to the existing
        // SHIPMENT_PENDING recreate state and must NEVER write DELETED.
        expect(code).toContain('shipmentStatus: "SHIPMENT_PENDING"');
        expect(code).not.toContain('shipmentStatus: "DELETED"');
        // Local DELETED is an explicit terminal early-return.
        expect(code).toContain("LOCAL_TERMINAL_DELETED");
        // It must not call the provider create endpoint.
        expect(code).not.toContain("createMengantarOrder");
        expect(code).not.toContain("payMengantarUnpaid");
    });
});
