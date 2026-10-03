/**
 * ==========================================
 * MENGANTAR ADMIN STATUS + RECONCILE MATRIX
 * ==========================================
 *
 * Run:
 *   npx jest __tests__/security/mengantar-admin-status.test.ts --runInBand
 *
 * Covers the dashboard/reporting surface for the stale-shipment fix:
 *   - the shared pure "Status Mengantar" resolver used by BOTH the
 *     /admin/orders list and the /admin/orders/[id] detail page,
 *   - the required reconcile behavior matrix (exists / missing /
 *     isDeleted / repeated / cancelled / non-Mengantar),
 *   - source guards that wire the list + detail + API together.
 *
 * The provider is fully MOCKED — no request reaches Mengantar.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

/* ==========================================
 * MOCKS (reconcile only)
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
    },
}));

jest.mock("@/lib/mengantar", () => ({
    MengantarError: class MengantarError extends Error {
        status?: number;
        code?: string;
    },
    getMengantarOrderByOrderId: jest.fn(),
    getMengantarOrderByTracking: jest.fn(),
    redactMengantarKey: (value: unknown) =>
        String(value ?? ""),
}));

jest.mock("@/lib/admin/audit-log", () => ({
    createAuditLog: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/admin/audit-log";
import {
    getMengantarOrderByOrderId,
    getMengantarOrderByTracking,
} from "@/lib/mengantar";
import {
    reconcileMengantarShipment,
    reconcileMengantarShipments,
} from "@/lib/mengantar/reconcile";
import {
    resolveMengantarAdminStatus,
    isMengantarShippingProvider,
} from "@/lib/mengantar/admin-status";

const mockedOrder = prisma.order as unknown as {
    findMany: jest.Mock;
    updateMany: jest.Mock;
};
const mockedJob = (
    prisma as unknown as {
        shipmentJob: {
            updateMany: jest.Mock;
            createMany: jest.Mock;
        };
    }
).shipmentJob;
const mockedAudit = createAuditLog as unknown as jest.Mock;
const mockedLookup =
    getMengantarOrderByOrderId as unknown as jest.Mock;
const mockedTrackingLookup =
    getMengantarOrderByTracking as unknown as jest.Mock;

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

function resetCalls() {
    return mockedOrder.updateMany.mock.calls.filter(
        (call) =>
            (call[0] as { data?: { shipmentStatus?: string } })
                .data?.shipmentStatus === "SHIPMENT_PENDING"
    );
}

function resetCall() {
    return resetCalls()[0];
}

beforeEach(() => {
    jest.clearAllMocks();
});

/* ==========================================
 * 7. DASHBOARD STATUS RESOLVER
 * ========================================== */

describe("resolveMengantarAdminStatus", () => {
    it("non-Mengantar order → 'Tidak berlaku'", () => {
        const status = resolveMengantarAdminStatus({
            shippingProvider: null,
            shipmentStatus: "CREATED",
        });

        expect(status.isMengantar).toBe(false);
        expect(status.kind).toBe("NOT_APPLICABLE");
        expect(status.label).toBe("Tidak berlaku");
    });

    it("Mengantar + never created → 'Belum dibuat'", () => {
        for (const value of [null, "", "NOT_CREATED"]) {
            const status = resolveMengantarAdminStatus({
                shippingProvider: "MENGANTAR",
                shipmentStatus: value,
                providerShipmentId: null,
            });

            expect(status.kind).toBe("NOT_CREATED");
            expect(status.label).toBe("Belum dibuat");
            expect(status.hasProviderShipment).toBe(false);
        }
    });

    it("Mengantar + created → 'Terbuat' with the provider shipment id", () => {
        const status = resolveMengantarAdminStatus({
            shippingProvider: "MENGANTAR",
            shipmentStatus: "CREATED",
            providerShipmentId: ORDER_ID,
            trackingNumber: "JO1",
        });

        expect(status.kind).toBe("CREATED");
        expect(status.label).toBe("Terbuat");
        expect(status.hasProviderShipment).toBe(true);
        expect(status.trackingNumber).toBe("JO1");
    });

    it("Mengantar + local termination → 'Dihapus manual (terminal)' (distinct)", () => {
        const status = resolveMengantarAdminStatus({
            shippingProvider: "MENGANTAR",
            shipmentStatus: "DELETED",
            providerShipmentId: null,
        });

        expect(status.kind).toBe("DELETED");
        expect(status.label).toBe("Dihapus manual (terminal)");
        // Must read differently from "Belum dibuat" and from the
        // recoverable "Pending" recreate state.
        expect(status.label).not.toBe("Belum dibuat");
        expect(status.label).not.toBe("Pending");
    });

    it("Mengantar external deletion recovery → 'Pending' (recreate)", () => {
        const status = resolveMengantarAdminStatus({
            shippingProvider: "MENGANTAR",
            shipmentStatus: "SHIPMENT_PENDING",
            providerShipmentId: null,
        });

        expect(status.kind).toBe("PENDING");
        expect(status.label).toBe("Pending");
    });

    it("maps every main state to a distinct, non-empty label", () => {
        const table: Array<[string, string]> = [
            ["NOT_CREATED", "Belum dibuat"],
            ["SHIPMENT_PENDING", "Pending"],
            ["CREATING", "Processing"],
            ["PAYING", "Processing"],
            ["WAITING_SHIPPING_PAYMENT", "Menunggu bayar ongkir"],
            ["FAILED", "Gagal"],
            ["SHIPPING_PAID", "Terbuat"],
            ["CREATED", "Terbuat"],
            ["PICKED_UP", "Diambil kurir"],
            ["IN_TRANSIT", "Dikirim"],
            ["DELIVERED", "Terkirim"],
            ["RETURNED", "Dikembalikan"],
            ["CANCELLED", "Dibatalkan"],
            ["DELETED", "Dihapus manual (terminal)"],
        ];

        for (const [raw, label] of table) {
            expect(
                resolveMengantarAdminStatus({
                    shippingProvider: "MENGANTAR",
                    shipmentStatus: raw,
                    providerShipmentId: ORDER_ID,
                }).label
            ).toBe(label);
        }
    });

    it("is case/whitespace tolerant on the provider", () => {
        expect(isMengantarShippingProvider(" mengantar ")).toBe(
            true
        );
        expect(
            resolveMengantarAdminStatus({
                shippingProvider: "mengantar",
                shipmentStatus: "created",
            }).label
        ).toBe("Terbuat");
    });
});

/* ==========================================
 * 1–6. RECONCILE BEHAVIOR MATRIX
 * ========================================== */

describe("reconcile behavior matrix", () => {
    it("1. provider shipment exists → no recreate", async () => {
        mockedLookup.mockResolvedValue({ isDeleted: false });

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.reconciled).toBe(false);
        expect(result.verdict).toBe("exists");
        expect(resetCall()).toBeUndefined();
        expect(mockedJob.createMany).not.toHaveBeenCalled();
    });

    it("2. provider shipment missing → reset + recreate", async () => {
        mockedLookup.mockResolvedValue(null);
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });
        mockedJob.updateMany.mockResolvedValue({ count: 1 });

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.reconciled).toBe(true);
        expect(result.action).toBe("recreated");

        const reset = resetCall();
        expect(reset).toBeDefined();
        expect(reset[0].data).toEqual(
            expect.objectContaining({
                providerShipmentId: null,
                providerBatchId: null,
                trackingNumber: null,
                shippingPaymentStatus: null,
            })
        );
        expect(mockedJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "PENDING",
                }),
            })
        );
    });

    it("3. local CREATED + isDeleted:true → recoverable (reset + re-queue)", async () => {
        mockedLookup.mockResolvedValue({ isDeleted: true });
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });
        mockedJob.updateMany.mockResolvedValue({ count: 1 });

        const result = await reconcileMengantarShipment(
            createdOrder()
        );

        expect(result.verdict).toBe("deleted");
        expect(result.action).toBe("recreated");
        expect(
            mockedOrder.updateMany.mock.calls[0][0].data
                .shipmentStatus
        ).toBe("SHIPMENT_PENDING");
        expect(resetCalls()).toHaveLength(1);
        expect(mockedAudit).toHaveBeenCalledTimes(1);
    });

    it("3b. local DELETED + isDeleted:true → terminal, never recreate", async () => {
        mockedLookup.mockResolvedValue({ isDeleted: true });

        const result = await reconcileMengantarShipment(
            createdOrder({ shipmentStatus: "DELETED" })
        );

        expect(result.verdict).toBe("local_deleted");
        expect(result.reconciled).toBe(false);
        expect(resetCalls()).toHaveLength(0);
        expect(mockedJob.createMany).not.toHaveBeenCalled();
    });

    it("4. reconcile twice → one reset, no duplicate shipment", async () => {
        mockedLookup.mockResolvedValue(null);
        mockedOrder.updateMany.mockResolvedValue({ count: 1 });
        mockedJob.updateMany.mockResolvedValue({ count: 1 });

        const first = await reconcileMengantarShipment(
            createdOrder()
        );
        // After the reset the ids are cleared, so a SECOND pass can no
        // longer confirm anything (no identifier) → strict no-op. This
        // is what makes the recreate idempotent.
        const second = await reconcileMengantarShipment(
            createdOrder({
                shipmentStatus: "SHIPMENT_PENDING",
                providerShipmentId: null,
                trackingNumber: null,
            })
        );

        expect(first.reconciled).toBe(true);
        expect(second.reconciled).toBe(false);
        expect(resetCalls()).toHaveLength(1);
        expect(mockedJob.updateMany).toHaveBeenCalledTimes(1);
        expect(mockedJob.createMany).not.toHaveBeenCalled();
    });

    it("5. CANCELLED/not-PAID order → CAS loses, no recreate", async () => {
        mockedLookup.mockResolvedValue(null);
        // The DB CAS re-checks PAID + not-CANCELLED at write time.
        mockedOrder.updateMany.mockResolvedValue({ count: 0 });

        const result = await reconcileMengantarShipment(
            createdOrder({ status: "CANCELLED" })
        );

        expect(result.reconciled).toBe(false);
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
        expect(mockedJob.createMany).not.toHaveBeenCalled();
    });

    it("6. sweep only scans Mengantar + CREATED + PAID + non-COD", async () => {
        mockedOrder.findMany.mockResolvedValue([]);

        const summary = await reconcileMengantarShipments();

        expect(summary).toEqual({ scanned: 0, reconciled: 0 });

        const where = mockedOrder.findMany.mock.calls[0][0].where;
        expect(where.shippingProvider).toBe("MENGANTAR");
        expect(where.shipmentStatus).toBe("CREATED");
        expect(where.paymentStatus).toBe("PAID");
        expect(where.paymentMethod).toEqual({ not: "COD" });
        expect(where.status).toEqual({ not: "CANCELLED" });
    });

    it("tracking-only fallback never turns an empty result into missing", async () => {
        mockedTrackingLookup.mockResolvedValue(null);

        const result = await reconcileMengantarShipment(
            createdOrder({
                providerShipmentId: null,
            })
        );

        expect(result.verdict).toBe("uncertain");
        expect(result.reconciled).toBe(false);
    });
});

/* ==========================================
 * DASHBOARD WIRING (source guards)
 * ========================================== */

describe("dashboard wiring", () => {
    const listPage = readFile(
        "components/admin/orders/AdminOrdersPage.tsx"
    );
    const detailPage = readFile(
        "app/admin/orders/[id]/page.tsx"
    );
    const listApi = readFile("app/api/admin/orders/route.ts");

    it("the list API exposes the Mengantar shipment fields", () => {
        expect(listApi).toContain("shippingProvider:");
        expect(listApi).toContain("shipmentStatus:");
        expect(listApi).toContain("shippingPaymentStatus:");
        expect(listApi).toContain("providerShipmentId:");
    });

    it("the list table renders a 'Status Mengantar' column via the shared resolver", () => {
        expect(listPage).toContain("Status Mengantar");
        expect(listPage).toContain(
            "resolveMengantarAdminStatus"
        );
        expect(listPage).toContain(
            '"@/lib/mengantar/admin-status"'
        );
    });

    it("the detail page shows a 'Status Mengantar' row via the shared resolver", () => {
        expect(detailPage).toContain("Status Mengantar");
        expect(detailPage).toContain(
            "resolveMengantarAdminStatus"
        );
        // Provider id + resi + ongkir payment status remain visible.
        expect(detailPage).toContain("Pembayaran ongkir");
        expect(detailPage).toContain("{shipmentId ?? \"-\"}");
    });

    it("the shared resolver is pure (no prisma / server-only)", () => {
        const helper = readFile(
            "lib/mengantar/admin-status.ts"
        );

        expect(helper).not.toContain("server-only");
        expect(helper).not.toContain("@/lib/prisma");
    });
});
