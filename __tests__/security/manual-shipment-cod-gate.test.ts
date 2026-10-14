/**
 * ==========================================
 * MANUAL SHIPMENT — COD REVIEW NO LONGER BLOCKS CREATION
 * ==========================================
 *
 * REQUIREMENT (owner correction): a successful COD checkout using
 * MENGANTAR must result in an automatic shipment/pickup request, even
 * while the COD review is PENDING. `requiresCodReview` /
 * `codReviewStatus` are a risk marker + audit trail — NOT a gate.
 *
 * This suite proves the removal at the single server choke point every
 * create path goes through (`createShipmentForOrder`), and through the
 * manual admin route:
 *
 *   review PENDING  → NOT refused by the review (proceeds)
 *   review REJECTED → NOT refused by the review (proceeds)
 *   review APPROVED → proceeds (unchanged)
 *   no review flag  → proceeds (unchanged)
 *
 * "Proceeds" is proven by the call reaching the NEXT real guard: with no
 * pickup configuration available it stops on "Konfigurasi pickup …"
 * instead of a review refusal — i.e. the review is no longer consulted,
 * and the remaining guards (cancelled / refunded / not-Mengantar /
 * intentional deletion) still are.
 *
 * Only prisma, auth, the audit log and the notification handler are
 * mocked; neither Mengantar nor the database is touched.
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

/*
 * Side effects are stubbed so this suite stays provider- and
 * notification-free. Neither is asserted here: the point of the suite
 * is that the COD review no longer reaches the create path at all.
 */
jest.mock("@/lib/admin/audit-log", () => ({
    createAuditLog: jest.fn(async () => undefined),
}));

jest.mock("@/lib/notification/order-status-handler", () => ({
    onShipmentStatusChanged: jest.fn(async () => undefined),
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
 * 1 — THE CHOKE POINT NO LONGER CONSULTS THE REVIEW
 * ========================================== */

describe("createShipmentForOrder ignores the COD review state", () => {
    test.each([
        ["PENDING", "PENDING"],
        ["REJECTED", "REJECTED"],
        ["APPROVED", "APPROVED"],
    ])(
        "a COD order with a %s review is NOT refused by the review",
        async (_label, reviewStatus) => {
            mockedOrder.findUnique.mockResolvedValue(
                codOrder({ codReviewStatus: reviewStatus })
            );

            const result = await createShipmentForOrder(ORDER_ID, {
                allowDeleted: true,
            });

            /*
             * It stops on the REAL next guard (missing pickup
             * configuration), which is only reachable if the review did
             * not return early.
             */
            expect(result.reason).toContain(
                "Konfigurasi pickup"
            );
            expect(mockStoreSetting.findUnique).toHaveBeenCalled();
        }
    );

    test("an unflagged COD order behaves identically", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({
                requiresCodReview: false,
                codReviewStatus: null,
            })
        );

        const result = await createShipmentForOrder(ORDER_ID, {
            allowDeleted: true,
        });

        expect(result.reason).toContain("Konfigurasi pickup");
    });

    test("the other guards still hold: a CANCELLED order is refused", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ status: "CANCELLED" })
        );

        const result = await createShipmentForOrder(ORDER_ID, {
            allowDeleted: true,
        });

        expect(result.ok).toBe(false);
        expect(result.reason).not.toContain("Konfigurasi pickup");
    });

    test("the other guards still hold: a non-Mengantar order is refused", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            codOrder({ shippingProvider: null })
        );

        const result = await createShipmentForOrder(ORDER_ID, {
            allowDeleted: true,
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toContain("Mengantar");
    });
});

/* ==========================================
 * 2 — THE MANUAL ADMIN BUTTON
 * ========================================== */

describe("POST /api/admin/orders/[id]/shipment", () => {
    test.each([
        ["PENDING", "PENDING"],
        ["REJECTED", "REJECTED"],
    ])(
        "a %s review is NOT answered with a review refusal",
        async (_label, reviewStatus) => {
            mockedOrder.findUnique.mockResolvedValue(
                codOrder({ codReviewStatus: reviewStatus })
            );

            const response = await shipmentPOST(
                shipmentRequest(),
                CONTEXT
            );
            const body = await response.json();

            /*
             * 400 (a real provider/config failure), never a 409 named
             * after the review: the review no longer blocks the button.
             */
            expect(response.status).toBe(400);
            expect(body.data).toBeUndefined();
            expect(body.message).toContain("Konfigurasi pickup");
        }
    );

    test("an unauthenticated caller never reaches the create path", async () => {
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
 * 3 — NO HIDDEN REVIEW GUARD REMAINS
 * ========================================== */

/**
 * Strip block and line comments so the assertions below can only be
 * satisfied by real CODE — a review guard documented in a comment must
 * still count as "no guard", while one written as an `if` must not.
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/*
 * The three files below are the COMPLETE set of code paths that can
 * create a Mengantar shipment, so a hidden review guard would HAVE to
 * read one of the review columns in one of them. The assertion is
 * therefore deliberately broad: after comments are stripped, neither
 * column may appear AT ALL. Matching one exact legacy line instead
 * would let a differently shaped gate slip through.
 */
describe("no create path consults the COD review", () => {
    const lib = readFile("lib/mengantar/shipment.ts");
    const worker = readFile("lib/mengantar/shipment-worker.ts");
    const manual = readFile(
        "app/api/admin/orders/[id]/shipment/route.ts"
    );

    /* The anchors prove each file was really read (not a stale empty
       string, which would make "does not contain" pass vacuously). */
    test("the shipment choke point has no review condition", () => {
        expect(lib).toContain("createShipmentForOrder");
        expect(lib).not.toContain("reviewBlocked");

        const code = stripComments(lib);
        expect(code).not.toContain("requiresCodReview");
        expect(code).not.toContain("codReviewStatus");
    });

    test("the worker has no review condition on any path", () => {
        expect(worker).toContain("createShipmentForOrder(");
        expect(worker).not.toContain("reviewBlocked");

        const code = stripComments(worker);
        expect(code).not.toContain("requiresCodReview");
        expect(code).not.toContain("codReviewStatus");
    });

    test("the manual route has no review branch", () => {
        expect(manual).toContain("createShipmentForOrder(orderId");
        expect(manual).not.toContain("reviewBlocked");
        expect(manual).not.toContain("codReviewBlocked");

        const code = stripComments(manual);
        expect(code).not.toContain("requiresCodReview");
        expect(code).not.toContain("codReviewStatus");
    });
});
