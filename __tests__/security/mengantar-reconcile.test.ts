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

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
        shipmentJob: mockShipmentJob,
        orderItem: { findMany: jest.fn() },
    },
}));

jest.mock("@/lib/mengantar", () => ({
    MengantarError: class MengantarError extends Error {
        status?: number;
        code?: string;
    },
    getMengantarOrderByTracking: jest.fn(),
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
} from "@/lib/mengantar";
import {
    getMengantarOriginConfig,
    resolveMengantarDestinationAreaId,
} from "@/lib/mengantar/shipping";
import { processShipmentJobs } from "@/lib/mengantar/shipment-worker";

import {
    classifyMengantarLookup,
    classifyMengantarLookupError,
    reconcileMengantarShipment,
    reconcileMengantarShipments,
    verifyMengantarShipment,
} from "@/lib/mengantar/reconcile";
import { createShipmentForOrder } from "@/lib/mengantar/shipment";

import { GET as cronGET } from "@/app/api/cron/shipment-reconcile/route";

const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
};
const mockedJob = prisma.shipmentJob as unknown as {
    updateMany: jest.Mock;
    createMany: jest.Mock;
};
const mockedLookup =
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
});

/* ==========================================
 * PURE CLASSIFICATION
 * ========================================== */

describe("provider lookup classification", () => {
    it("exists only for an exact ORDER_ID match", () => {
        expect(
            classifyMengantarLookup(
                { orderId: ORDER_ID },
                ORDER_ID
            )
        ).toBe("exists");
    });

    it("missing for an empty provider result", () => {
        expect(
            classifyMengantarLookup(null, ORDER_ID)
        ).toBe("missing");
    });

    it("missing when the id differs (not our shipment)", () => {
        expect(
            classifyMengantarLookup(
                { orderId: "OTHER" },
                ORDER_ID
            )
        ).toBe("missing");
    });

    it("uncertain when the provider entry has no ORDER_ID", () => {
        expect(
            classifyMengantarLookup(
                { orderId: null },
                ORDER_ID
            )
        ).toBe("uncertain");
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

    it("never reconciles an order without a resi (cannot verify)", async () => {
        const result = await verifyMengantarShipment({
            providerShipmentId: ORDER_ID,
            trackingNumber: null,
        });

        expect(result).toBe("uncertain");
        expect(mockedLookup).not.toHaveBeenCalled();
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
        expect(finalize.data.shipmentStatus).toBe("CREATED");
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
