/**
 * ==========================================
 * COD + MENGANTAR ORDER LIFECYCLE — NEVER AUTO-CANCELLED
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-cod-lifecycle.test.ts
 *
 * Regression for the production bug where a COD + MENGANTAR order was
 * immediately CANCELLED, which made the shipment worker cancel its
 * ShipmentJob with "Pesanan dibatalkan/direfund.".
 *
 * Root cause guarded here:
 *   A COD order legitimately stays `paymentStatus = UNPAID` (the
 *   customer pays the courier on delivery) while its `status` is
 *   `PENDING`. The automatic online-payment lifecycle (expiry /
 *   checkout cleanup) cancels through the SHARED
 *   `rollbackCheckoutOrder()` CAS, which previously matched on
 *   `status IN ('PENDING','PROCESSING')` only — so a live COD order
 *   could be swept to CANCELLED, and the worker then cancelled the job.
 *
 * The fix (a) makes `rollbackCheckoutOrder` refuse COD unless a caller
 * EXPLICITLY opts in, and (b) makes `expireUnpaidOrderIfExpired`
 * refuse COD outright. Legitimate cancellation (admin route, customer
 * self-cancel) and refund handling are untouched.
 */

import { readFileSync } from "fs";

function readFile(path: string): string {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return "";
    }
}

/* ==========================================
 * MOCKS — checkout rollback dependencies
 * ========================================== */

let capturedSql = "";
let capturedValues: unknown[] = [];

const mockTx = {
    // rollbackCheckoutOrder's atomic CAS. Returning 0 means the CAS
    // matched nothing, so the rollback early-returns right after it.
    $executeRaw: jest.fn(),
};

const mockPrisma = {
    order: {
        findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
};

jest.mock("@/lib/prisma", () => ({
    prisma: mockPrisma,
}));

jest.mock("@/lib/mengantar/shipping", () => ({
    verifyMengantarShippingCost: jest.fn(async () => 15000),
    getMengantarOriginConfig: jest.fn(async () => null),
    resolveMengantarDestinationAreaId: jest.fn(async () => null),
}));

jest.mock("@/lib/payment/ipaymu", () => ({
    formatProductName: (productName: string, variantName: string) =>
        `${productName} - ${variantName}`,
    buildPaymentInstruction: jest.fn(),
    createDirectPayment: jest.fn(),
    resolveProviderMethod: jest.fn(),
    sanitizePaymentNo: jest.fn((v: unknown) => v ?? null),
}));

import { rollbackCheckoutOrder } from "@/lib/checkout";
import { expireUnpaidOrderIfExpired } from "@/lib/payment/order-payment";

const ONE_HOUR_MS = 60 * 60 * 1000;

function primeMocks(): void {
    capturedSql = "";
    capturedValues = [];

    mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
        if (typeof arg === "function") {
            return (arg as (tx: unknown) => unknown)(mockTx);
        }
        return Promise.all(arg as Promise<unknown>[]);
    });

    mockTx.$executeRaw.mockImplementation(
        (strings: TemplateStringsArray, ...values: unknown[]) => {
            capturedSql = Array.isArray(strings)
                ? strings.join(" @@ ")
                : String(strings);
            capturedValues = values;
            return Promise.resolve(0);
        }
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    primeMocks();
});

/* ==========================================
 * BEHAVIOUR — the automatic lifecycle
 * ========================================== */

describe("COD order is never auto-cancelled by the online-payment lifecycle", () => {
    it("expireUnpaidOrderIfExpired refuses COD even in the worst case (PENDING/PENDING + expired)", async () => {
        mockPrisma.order.findFirst.mockResolvedValue({
            id: 969,
            status: "PENDING",
            paymentStatus: "PENDING",
            paymentMethod: "COD",
            paymentExpiresAt: new Date(Date.now() - ONE_HOUR_MS),
        });

        const result = await expireUnpaidOrderIfExpired(969, "user-1");

        expect(result).toBe("NOT_CANCELLABLE");
        // The cancellation CAS was never even attempted.
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it("still settles a genuinely expired NON-COD order (the guard is COD-scoped)", async () => {
        mockPrisma.order.findFirst.mockResolvedValue({
            id: 970,
            status: "PENDING",
            paymentStatus: "PENDING",
            paymentMethod: "QRIS",
            paymentExpiresAt: new Date(Date.now() - ONE_HOUR_MS),
        });

        const result = await expireUnpaidOrderIfExpired(970, "user-1");

        expect(result).toBe("EXPIRED");
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it("rollbackCheckoutOrder excludes COD from the cancellation CAS by default", async () => {
        await rollbackCheckoutOrder(969);

        // The CAS itself refuses COD...
        expect(capturedSql).toContain("paymentMethod <> 'COD'");
        // ...because the explicit opt-in defaults to false.
        expect(capturedValues).toContain(false);
        expect(capturedValues).not.toContain(true);
    });

    it("rollbackCheckoutOrder can still cancel a COD order when explicitly allowed", async () => {
        await rollbackCheckoutOrder(969, { allowCodCancellation: true });

        expect(capturedValues).toContain(true);
    });
});

/* ==========================================
 * SOURCE — where each caller stands
 * ========================================== */

describe("COD cancellation intent is explicit per caller", () => {
    const checkoutLib = readFile("lib/checkout.ts").replace(/\r\n/g, "\n");

    it("the automatic checkout cleanup does NOT opt in to COD cancellation", () => {
        const start = checkoutLib.indexOf(
            "export async function cleanupPendingCheckoutOrders("
        );
        const end = checkoutLib.indexOf(
            "export async function createCheckoutOrder("
        );
        expect(start).toBeGreaterThan(-1);
        const section = checkoutLib.substring(start, end);

        // Never selects COD, and never opts in.
        expect(section).toContain('"BANK_TRANSFER"');
        expect(section).toContain('"QRIS"');
        expect(section).not.toContain("allowCodCancellation");
    });

    it("an explicit customer cancellation DOES opt in", () => {
        const start = checkoutLib.indexOf(
            "export async function cancelOwnPendingOrder("
        );
        const end = checkoutLib.indexOf(
            "export async function clearCart("
        );
        expect(start).toBeGreaterThan(-1);
        const section = checkoutLib.substring(start, end);

        expect(section).toContain("allowCodCancellation: true");
    });

    it("expireUnpaidOrderIfExpired has an explicit COD refusal", () => {
        const src = readFile("lib/payment/order-payment.ts");
        const start = src.indexOf(
            "export async function expireUnpaidOrderIfExpired("
        );
        expect(start).toBeGreaterThan(-1);
        const section = src.substring(start, start + 2600);

        expect(section).toContain('order.paymentMethod === "COD"');
        expect(section).toContain("NOT_CANCELLABLE");
    });

    it("the worker guard is NOT bypassed (cancelled orders still cancel the job)", () => {
        const worker = readFile("lib/mengantar/shipment-worker.ts");
        expect(worker).toContain('order.status === "CANCELLED"');
        expect(worker).toContain("Pesanan dibatalkan/direfund.");
    });
});
