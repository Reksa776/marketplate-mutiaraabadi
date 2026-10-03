/**
 * ==========================================
 * MENGANTAR ADMIN INTENTIONAL DELETION
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-admin-delete.test.ts
 *
 * The admin "Hapus Shipment" action must be a PERSISTENT, server-
 * authoritative intentional-deletion signal (`shipmentStatus =
 * "DELETED"`). After it:
 *   - reconcile/cron NEVER auto-recreate
 *   - a queued worker job NEVER POSTs /order
 *   - the order stays PAID (payment/order amount untouched)
 *   - manual admin recovery still works via the existing create flow
 *
 * The provider is fully MOCKED — no request ever reaches Mengantar.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const mockOrder = {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
};
const mockShipmentJob = {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    createMany: jest.fn(),
    upsert: jest.fn(),
};
const mockOrderItem = { findMany: jest.fn() };
const mockAuditLog = { create: jest.fn() };

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
        shipmentJob: mockShipmentJob,
        orderItem: mockOrderItem,
        adminAuditLog: mockAuditLog,
    },
}));

jest.mock("@/lib/mengantar", () => ({
    MengantarError: class MengantarError extends Error {
        status?: number;
        code?: string;
    },
    getMengantarOrderByOrderId: jest.fn(),
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

jest.mock("@/lib/notification/order-status-handler", () => ({
    onShipmentStatusChanged: jest.fn().mockResolvedValue(undefined),
}));

import {
    createMengantarOrder,
    getMengantarOrderByOrderId,
} from "@/lib/mengantar";
import {
    getMengantarOriginConfig,
    resolveMengantarDestinationAreaId,
} from "@/lib/mengantar/shipping";
import {
    createShipmentForOrder,
    deleteMengantarShipmentForOrder,
} from "@/lib/mengantar/shipment";
import {
    reconcileMengantarShipment,
    reconcileMengantarShipments,
} from "@/lib/mengantar/reconcile";
import { processShipmentJobs } from "@/lib/mengantar/shipment-worker";

const mockedOrder = mockOrder;
const mockedJob = mockShipmentJob;
const mockedAudit = mockAuditLog;
const mockedLookup =
    getMengantarOrderByOrderId as unknown as jest.Mock;
const mockedCreateOrder =
    createMengantarOrder as unknown as jest.Mock;
const mockedOrigin =
    getMengantarOriginConfig as unknown as jest.Mock;
const mockedResolveDestination =
    resolveMengantarDestinationAreaId as unknown as jest.Mock;

const ORDER_ID = "260130OVBBOO";

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

/** Candidate row shape used by reconcile. */
function candidate(overrides: Record<string, unknown> = {}) {
    return {
        id: 963,
        providerShipmentId: ORDER_ID,
        trackingNumber: "JO0328436240",
        shipmentStatus: "CREATED",
        ...overrides,
    };
}

/** Full order row selected by createShipmentForOrder. */
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

function createdProviderItem(overrides: Record<string, unknown> = {}) {
    return {
        ORDER_ID: "NEW-ORDER-1",
        batch_id: "NEW-BATCH",
        cnote_no: "NEW-CNOTE",
        isPaid: true,
        error: null,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();

    mockedOrigin.mockResolvedValue({
        originAreaId: "origin-area",
        pickupAddressId: "pickup-addr",
        pickupTimeId: null,
    });
    mockedResolveDestination.mockResolvedValue("dest-area");

    mockOrderItem.findMany.mockResolvedValue([
        {
            productName: "Kaos",
            variantName: "L",
            quantity: 1,
            variant: { weight: 1000 },
        },
    ]);

    mockOrder.findUnique.mockResolvedValue(null);
    mockOrder.findMany.mockResolvedValue([]);
    mockOrder.updateMany.mockResolvedValue({ count: 1 });

    mockShipmentJob.findUnique.mockResolvedValue(null);
    mockShipmentJob.findMany.mockResolvedValue([]);
    mockShipmentJob.updateMany.mockResolvedValue({ count: 1 });
    mockShipmentJob.createMany.mockResolvedValue({ count: 0 });
    mockShipmentJob.upsert.mockResolvedValue({ id: 1 });

    mockAuditLog.create.mockResolvedValue({});

    mockedLookup.mockResolvedValue(null);
});

/* ==========================================================
 * 1. DELETE FROM THE SHIPMENT PANEL
 * ========================================================== */

describe("deleteMengantarShipmentForOrder", () => {
    it("1. clears ids, sets DELETED, keeps PAID, cancels jobs, audits", async () => {
        mockOrder.findUnique.mockResolvedValue({
            id: 963,
            shippingProvider: "MENGANTAR",
            shipmentStatus: "CREATED",
            providerShipmentId: ORDER_ID,
            providerBatchId: "BATCH-1",
            trackingNumber: "JO0328436240",
        });

        const result = await deleteMengantarShipmentForOrder(
            963,
            "admin-1"
        );

        expect(result.ok).toBe(true);
        expect(result.changed).toBe(true);
        expect(result.shipmentStatus).toBe("DELETED");

        const clear = mockedOrder.updateMany.mock.calls[0][0];
        // CAS pinned to the exact state read.
        expect(clear.where).toEqual(
            expect.objectContaining({
                id: 963,
                shippingProvider: "MENGANTAR",
                shipmentStatus: "CREATED",
                providerShipmentId: ORDER_ID,
            })
        );
        expect(clear.data).toEqual(
            expect.objectContaining({
                shipmentStatus: "DELETED",
                providerShipmentId: null,
                providerBatchId: null,
                trackingNumber: null,
            })
        );
        // NEVER touches the customer payment / order amount.
        expect(clear.data).not.toHaveProperty("paymentStatus");
        expect(clear.data).not.toHaveProperty("status");
        expect(clear.data).not.toHaveProperty("total");

        // Queued/claimed job invalidated.
        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    orderId: 963,
                }),
                data: expect.objectContaining({
                    status: "CANCELLED",
                }),
            })
        );

        // No provider shipment creation.
        expect(mockedCreateOrder).not.toHaveBeenCalled();

        // Safe audit.
        expect(mockedAudit.create).toHaveBeenCalledTimes(1);
        const audit = mockedAudit.create.mock.calls[0][0].data;
        expect(audit.action).toBe(
            "MENGANTAR_SHIPMENT_DELETED_EXTERNALLY"
        );
        expect(audit.entityType).toBe("Order");
        expect(audit.entityId).toBe(963);
        expect(audit.adminId).toBe("admin-1");
        expect(JSON.stringify(audit)).not.toMatch(
            /api[_-]?key|webhook|secret|token|cron/i
        );
    });

    it("9. double click is idempotent (no second write / audit)", async () => {
        mockOrder.findUnique.mockResolvedValue({
            id: 963,
            shippingProvider: "MENGANTAR",
            shipmentStatus: "DELETED",
            providerShipmentId: null,
            providerBatchId: null,
            trackingNumber: null,
        });

        const second = await deleteMengantarShipmentForOrder(
            963,
            "admin-1"
        );

        expect(second.ok).toBe(true);
        expect(second.changed).toBe(false);
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedAudit.create).not.toHaveBeenCalled();
    });

    it("4b. a lost CAS clears nothing and audits nothing", async () => {
        mockOrder.findUnique.mockResolvedValue({
            id: 963,
            shippingProvider: "MENGANTAR",
            shipmentStatus: "CREATED",
            providerShipmentId: ORDER_ID,
            providerBatchId: "BATCH-1",
            trackingNumber: "JO0328436240",
        });
        // A concurrent create/worker moved the state → CAS misses.
        mockedOrder.updateMany.mockResolvedValue({ count: 0 });

        const result = await deleteMengantarShipmentForOrder(
            963,
            "admin-1"
        );

        expect(result.ok).toBe(false);
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedAudit.create).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("refuses a non-MENGANTAR order", async () => {
        mockOrder.findUnique.mockResolvedValue({
            id: 963,
            shippingProvider: null,
            shipmentStatus: "CREATED",
            providerShipmentId: ORDER_ID,
            providerBatchId: null,
            trackingNumber: null,
        });

        const result = await deleteMengantarShipmentForOrder(
            963,
            "admin-1"
        );

        expect(result.ok).toBe(false);
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
    });
});

/* ==========================================================
 * 2. CRON / RECONCILE AFTER DELETE
 * ========================================================== */

describe("reconcile after intentional deletion", () => {
    it("2. the sweep never scans a DELETED order → 0 enqueue / 0 POST", async () => {
        // The sweep's WHERE is pinned to CREATED, so a DELETED order is
        // simply never a candidate.
        mockOrder.findMany.mockResolvedValue([]);

        const sweep = await reconcileMengantarShipments({
            limit: 25,
        });

        expect(
            mockedOrder.findMany.mock.calls[0][0].where
                .shipmentStatus
        ).toBe("CREATED");

        expect(sweep.reconciled).toBe(0);
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.createMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("2b. a stale candidate for a DELETED order cannot reset/enqueue", async () => {
        // Even if a stale candidate carries the OLD id, the reset CAS
        // requires shipmentStatus CREATED and fails.
        mockedLookup.mockResolvedValue(null);
        mockedOrder.updateMany.mockResolvedValue({ count: 0 });

        const result = await reconcileMengantarShipment(
            candidate({ shipmentStatus: "DELETED" })
        );

        expect(result.reconciled).toBe(false);
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.createMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("2c. a DELETED order with cleared ids is inconclusive → no-op", async () => {
        const result = await reconcileMengantarShipment(
            candidate({
                shipmentStatus: "DELETED",
                providerShipmentId: null,
                trackingNumber: null,
            })
        );

        expect(result.verdict).toBe("uncertain");
        expect(result.reconciled).toBe(false);
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });
});

/* ==========================================================
 * 3. EXISTING QUEUED JOB + DELETE
 * ========================================================== */

describe("queued worker job after intentional deletion", () => {
    it("3. a claimed job for a DELETED order is cancelled, never POSTed", async () => {
        mockedJob.updateMany.mockResolvedValue({ count: 1 });
        mockedJob.findMany.mockResolvedValue([
            { id: 1, orderId: 963 },
        ]);
        mockedJob.findUnique.mockResolvedValue({
            id: 1,
            orderId: 963,
            status: "PROCESSING",
            stage: "CREATE",
            attempts: 1,
            maxAttempts: 6,
            lastError: null,
        });
        mockOrder.findUnique.mockResolvedValue({
            id: 963,
            status: "PAID",
            paymentStatus: "PAID",
            paymentMethod: "BANK_TRANSFER",
            shippingProvider: "MENGANTAR",
            shipmentStatus: "DELETED",
            shippingPaymentStatus: null,
        });

        await processShipmentJobs();

        expect(mockedCreateOrder).not.toHaveBeenCalled();
        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "CANCELLED",
                }),
            })
        );
    });

    it("3b. createShipmentForOrder refuses DELETED without admin opt-in", async () => {
        mockOrder.findUnique.mockResolvedValue(
            baseOrder({
                shipmentStatus: "DELETED",
                providerShipmentId: null,
            })
        );

        const result = await createShipmentForOrder(963);

        expect(result.ok).toBe(false);
        expect(result.shipmentStatus).toBe("DELETED");
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });
});

/* ==========================================================
 * 4. CONCURRENT DELETE + RECONCILE
 * ========================================================== */

describe("concurrent delete + reconcile", () => {
    it("4. delete wins → reconcile loses the CAS, no recreate", async () => {
        mockedLookup.mockResolvedValue(null);
        mockOrder.findMany.mockResolvedValue([candidate()]);
        // The delete already moved CREATED → DELETED, so the reset CAS
        // misses and NO job is enqueued.
        mockedOrder.updateMany.mockResolvedValue({ count: 0 });

        const sweep = await reconcileMengantarShipments({
            limit: 25,
        });

        expect(sweep.reconciled).toBe(0);
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("4b. reconcile wins → delete loses the CAS, no provider recreate", async () => {
        mockOrder.findUnique.mockResolvedValue({
            id: 963,
            shippingProvider: "MENGANTAR",
            shipmentStatus: "SHIPMENT_PENDING",
            providerShipmentId: null,
            providerBatchId: null,
            trackingNumber: null,
        });
        mockedOrder.updateMany.mockResolvedValue({ count: 0 });

        const result = await deleteMengantarShipmentForOrder(
            963,
            "admin-1"
        );

        expect(result.ok).toBe(false);
        expect(mockedAudit.create).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });
});

/* ==========================================================
 * 5-8. SELF-HEALING PRESERVED + MANUAL RECOVERY
 * ========================================================== */

describe("self-healing + manual recovery preserved", () => {
    it("5. WITHOUT deletion intent, provider-missing still recreates", async () => {
        mockOrder.findUnique.mockResolvedValue(
            baseOrder({
                shipmentStatus: "SHIPMENT_PENDING",
                providerShipmentId: null,
            })
        );
        mockedCreateOrder.mockResolvedValue({
            data: [createdProviderItem()],
            batch_id: "NEW-BATCH",
        });
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });

        const result = await createShipmentForOrder(963);

        expect(result.ok).toBe(true);
        expect(mockedCreateOrder).toHaveBeenCalledTimes(1);
        expect(result.shipmentId).toBe("NEW-ORDER-1");
    });

    it("6. provider still has the shipment → reconcile is a no-op", async () => {
        mockedLookup.mockResolvedValue({ orderId: ORDER_ID });

        const result = await reconcileMengantarShipment(candidate());

        expect(result.verdict).toBe("exists");
        expect(result.reconciled).toBe(false);
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("7. manual recovery from DELETED succeeds with a fresh id + resi", async () => {
        mockOrder.findUnique.mockResolvedValue(
            baseOrder({
                shipmentStatus: "DELETED",
                providerShipmentId: null,
                providerBatchId: null,
                trackingNumber: null,
            })
        );
        mockedCreateOrder.mockResolvedValue({
            data: [createdProviderItem()],
            batch_id: "NEW-BATCH",
        });
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });

        const result = await createShipmentForOrder(963, {
            allowDeleted: true,
        });

        expect(result.ok).toBe(true);
        expect(result.shipmentId).toBe("NEW-ORDER-1");
        expect(result.trackingNumber).toBe("NEW-CNOTE");

        // The admin claim explicitly allows the DELETED state.
        const claim = mockedOrder.updateMany.mock.calls[0][0];
        expect(
            claim.where.OR[1].shipmentStatus.in
        ).toContain("DELETED");
    });

    it("8. a CANCELLED order is never recovered (even with allowDeleted)", async () => {
        mockOrder.findUnique.mockResolvedValue(
            baseOrder({ status: "CANCELLED" })
        );

        const result = await createShipmentForOrder(963, {
            allowDeleted: true,
        });

        expect(result.ok).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
    });
});

/* ==========================================================
 * SOURCE GUARDS
 * ========================================================== */

describe("source guards", () => {
    const route = readFile(
        "app/api/admin/orders/[id]/shipment/route.ts"
    );
    const adminPage = readFile(
        "app/admin/orders/[id]/page.tsx"
    );

    it("exposes an ADMIN-only DELETE handler using the existing lib", () => {
        expect(route).toContain("export async function DELETE");
        expect(route).toContain(
            "deleteMengantarShipmentForOrder"
        );
        expect(route).toContain('session.user.role !== "ADMIN"');
    });

    it("the admin recovery POST opts into allowDeleted", () => {
        expect(route).toContain("allowDeleted: true");
        expect(route).toContain("createShipmentForOrder(orderId, {");
    });

    it("the shipment panel has a confirmed Hapus Shipment action", () => {
        expect(adminPage).toContain("deleteShipment");
        expect(adminPage).toContain("Hapus Shipment");
        expect(adminPage).toContain("dialog.confirm");
        expect(adminPage).toContain('method: "DELETE"');
        expect(adminPage).toContain(
            "tidak akan dibuat ulang otomatis"
        );
        // Never exposes a provider secret to the client.
        expect(adminPage).not.toContain("MENGANTAR_API_KEY");
        expect(adminPage).not.toContain(
            "MENGANTAR_WEBHOOK_SECRET"
        );
        expect(adminPage).not.toContain("CRON_SECRET");
    });

    it("DELETED is a first-class shipment state", () => {
        const status = readFile("lib/mengantar/status.ts");
        expect(status).toContain('"DELETED"');
    });

    it("no provider POST /order endpoint is reached by the delete path", () => {
        const shipment = readFile("lib/mengantar/shipment.ts");
        // deleteMengantarShipmentForOrder must not call the create API.
        const start = shipment.indexOf(
            "export async function deleteMengantarShipmentForOrder"
        );
        const end = shipment.indexOf(
            "export async function payUnpaidShipmentForOrder"
        );
        const slice = shipment.slice(start, end);

        expect(slice).toContain("shipmentStatus: \"DELETED\"");
        expect(slice).not.toContain("createMengantarOrder");
        expect(slice).not.toContain('paymentStatus:');
        expect(slice).not.toContain('method: "POST"');
    });
});
