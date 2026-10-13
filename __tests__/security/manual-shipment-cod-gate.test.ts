/**
 * ==========================================
 * MANUAL SHIPMENT — COD REVIEW GATE
 * ==========================================
 *
 * A high-risk COD order is FLAGGED at checkout and must never be handed
 * to the courier until an authorized admin APPROVES the review. The
 * hold has to survive every path that could create a shipment:
 *
 *   - the automatic worker / sweeper          (cod-review-gate.test.ts)
 *   - the admin "retry" button               (cod-review-gate.test.ts)
 *   - the MANUAL "Buat Shipment" button      (THIS suite)
 *
 * These tests run the REAL gate in lib/mengantar/shipment.ts, through
 * the REAL admin shipment route, with only prisma, auth, the audit log
 * and the notification handler mocked. Neither Mengantar nor the
 * database is touched: a gate-blocked order returns before any provider
 * call, and an approved order stops at the pickup-configuration check.
 *
 * Expected behaviour
 * ------------------
 *   PENDING  review → 409, no provider call
 *   REJECTED review → 409, no provider call (the order was cancelled)
 *   APPROVED review → the gate OPENS (any later failure is unrelated)
 *   no review flag  → the gate never applies (COD lifecycle unchanged)
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "manual-shipment-gate-secret";

jest.mock("@/auth", () => ({ auth: jest.fn() }));

const mockOrder = { findUnique: jest.fn() };
const mockStoreSetting = { findUnique: jest.fn(async () => null) };
const mockShipmentJob = {
    findUnique: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 0 })),
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
        storeSetting: mockStoreSetting,
        shipmentJob: mockShipmentJob,
    },
}));

const mockAudit = jest.fn(
    async (..._args: unknown[]) => undefined
);

jest.mock("@/lib/admin/audit-log", () => ({
    createAuditLog: (...args: unknown[]) => mockAudit(...args),
}));

const mockShipmentNotification = jest.fn(
    async (..._args: unknown[]) => undefined
);

jest.mock("@/lib/notification/order-status-handler", () => ({
    onShipmentStatusChanged: (...args: unknown[]) =>
        mockShipmentNotification(...args),
}));

import { readFileSync } from "fs";
import { resolve } from "path";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createShipmentForOrder } from "@/lib/mengantar/shipment";

import { POST as shipmentPOST } from "@/app/api/admin/orders/[id]/shipment/route";

const mockedAuth = auth as unknown as jest.Mock;
const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
};

const ORDER_ID = 963;

const CONTEXT = {
    params: Promise.resolve({ id: String(ORDER_ID) }),
} as never;

function readFile(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf-8");
}

function codOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: ORDER_ID,
        orderNumber: "PAY-CART-963",
        status: "PENDING",
        paymentMethod: "COD",
        paymentStatus: "UNPAID",
        requiresCodReview: true,
        codReviewStatus: "PENDING",
        shippingProvider: "MENGANTAR",
        providerCourier: "jne",
        providerShipmentId: null,
        providerBatchId: null,
        shipmentStatus: "SHIPMENT_PENDING",
        shippingPaymentStatus: null,
        trackingNumber: null,
        recipientName: "Budi",
        phone: "08123456789",
        address: "Jl. Test No. 1",
        province: "DKI Jakarta",
        city: "Jakarta Selatan",
        district: "Kebayoran",
        postalCode: "12110",
        total: "2500000.00",
        shippingCost: "20000.00",
        codAmount: "2520000.00",
        ...overrides,
    };
}

function adminSession() {
    mockedAuth.mockResolvedValue({
        user: { id: "admin-1", role: "ADMIN" },
    });
}

function shipmentRequest() {
    return new Request(
        `http://test/api/admin/orders/${ORDER_ID}/shipment`,
        { method: "POST" }
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    adminSession();
    mockStoreSetting.findUnique.mockResolvedValue(null);
});

/* ==========================================
 * THE GATE ITSELF (server-authoritative)
 * ========================================== */

describe("createShipmentForOrder honours the COD review hold", () => {
    test("a COD order awaiting review is refused with reviewBlocked", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "PENDING" })
        );

        const result = await createShipmentForOrder(ORDER_ID, {
            allowDeleted: true,
        });

        expect(result.ok).toBe(false);
        expect(result.reviewBlocked).toBe(true);
        expect(result.reason).toContain("tinjauan admin");

        // The hold is decided from the ORDER, before anything is
        // resolved or sent: no pickup config read, no provider call.
        expect(
            mockStoreSetting.findUnique
        ).not.toHaveBeenCalled();
    });

    test("a REJECTED COD order is refused for good", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "REJECTED" })
        );

        const result = await createShipmentForOrder(ORDER_ID, {
            allowDeleted: true,
        });

        expect(result.ok).toBe(false);
        expect(result.reviewBlocked).toBe(true);
        expect(result.reason).toContain("ditolak");
        expect(
            mockStoreSetting.findUnique
        ).not.toHaveBeenCalled();
    });

    test("an APPROVED COD order passes the gate", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "APPROVED" })
        );

        const result = await createShipmentForOrder(ORDER_ID, {
            allowDeleted: true,
        });

        // It stops later on missing pickup configuration — which is
        // exactly what proves the REVIEW gate is no longer blocking it.
        expect(result.reviewBlocked).toBeUndefined();
        expect(result.reason).toContain(
            "Konfigurasi pickup"
        );
        expect(mockStoreSetting.findUnique).toHaveBeenCalled();
    });

    test("the hold only applies to FLAGGED COD orders", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({
                requiresCodReview: false,
                codReviewStatus: null,
            })
        );

        const result = await createShipmentForOrder(ORDER_ID, {
            allowDeleted: true,
        });

        expect(result.reviewBlocked).toBeUndefined();
        expect(mockStoreSetting.findUnique).toHaveBeenCalled();

        // A stale REJECTED flag on a non-COD order must not block it.
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({
                paymentMethod: "QRIS",
                codReviewStatus: "REJECTED",
            })
        );

        const other = await createShipmentForOrder(ORDER_ID, {
            allowDeleted: true,
        });

        expect(other.reviewBlocked).toBeUndefined();
        expect(other.reason).toContain("Konfigurasi pickup");
    });
});

/* ==========================================
 * THE MANUAL BUTTON
 * ========================================== */

describe("POST /api/admin/orders/[id]/shipment", () => {
    test("a PENDING review answers 409 and creates nothing", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "PENDING" })
        );

        const response = await shipmentPOST(
            shipmentRequest(),
            CONTEXT
        );
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.data.codReviewBlocked).toBe(true);
        expect(body.message).toContain("tinjauan");

        // Nothing was audited or announced: no shipment happened.
        expect(mockAudit).not.toHaveBeenCalled();
        expect(
            mockShipmentNotification
        ).not.toHaveBeenCalled();
    });

    test("a REJECTED review answers 409", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "REJECTED" })
        );

        const response = await shipmentPOST(
            shipmentRequest(),
            CONTEXT
        );
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.data.codReviewBlocked).toBe(true);
        expect(mockAudit).not.toHaveBeenCalled();
    });

    test("a non-review failure stays a 400 (no false hold signal)", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ codReviewStatus: "APPROVED" })
        );

        const response = await shipmentPOST(
            shipmentRequest(),
            CONTEXT
        );
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.data).toBeUndefined();
        expect(body.message).toContain("Konfigurasi pickup");
    });

    test("an unauthenticated caller cannot reach the gate at all", async () => {
        mockedAuth.mockResolvedValue(null);

        const response = await shipmentPOST(
            shipmentRequest(),
            CONTEXT
        );

        expect(response.status).toBe(401);
        expect(mockedOrder.findUnique).not.toHaveBeenCalled();
    });

    test("an affiliate session is refused", async () => {
        mockedAuth.mockResolvedValue({
            user: { id: "aff-1", role: "AFFILIATOR" },
        });

        const response = await shipmentPOST(
            shipmentRequest(),
            CONTEXT
        );

        expect(response.status).toBe(403);
        expect(mockedOrder.findUnique).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * SINGLE CHOKE POINT
 * ========================================== */

describe("every shipment path goes through the one gate", () => {
    test("the gate lives in createShipmentForOrder, not in a caller", () => {
        const lib = readFile("lib/mengantar/shipment.ts");

        expect(lib).toContain("reviewBlocked: true");
        expect(lib).toMatch(
            /order\.requiresCodReview &&\s*order\.codReviewStatus !== "APPROVED"/
        );

        /*
         * The automatic worker and the manual route are the only two
         * callers, and the worker's own pre-check mirrors the gate
         * rather than replacing it — so a job introduced by a sweeper
         * or a reconcile re-queue still lands on the same decision.
         */
        const worker = readFile(
            "lib/mengantar/shipment-worker.ts"
        );

        expect(worker).toContain("createShipmentForOrder(");
        expect(worker).toMatch(
            /requiresCodReview &&[\s\S]{0,80}codReviewStatus !== "APPROVED"/
        );

        const manual = readFile(
            "app/api/admin/orders/[id]/shipment/route.ts"
        );

        expect(manual).toContain(
            "createShipmentForOrder(orderId"
        );
        expect(manual).toContain("result.reviewBlocked");
    });
});
