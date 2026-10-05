/**
 * ==========================================
 * COD + MENGANTAR ORDER LIFECYCLE — NEVER AUTO-CANCELLED
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-cod-lifecycle.test.ts
 *
 * Regression for the production bug where a COD + MENGANTAR order was
 * cancelled, which made the shipment worker cancel its ShipmentJob
 * with "Pesanan dibatalkan/direfund.".
 *
 * Root cause guarded here:
 *   A COD order legitimately stays `status = PENDING` and
 *   `paymentStatus = UNPAID` (the customer pays the courier on
 *   delivery). The automatic online-payment lifecycle (expiry /
 *   checkout cleanup) cancels through the SHARED
 *   `rollbackCheckoutOrder()` CAS, which previously matched on
 *   `status IN ('PENDING','PROCESSING')` only — so a live COD order
 *   could be swept to CANCELLED and the worker would then cancel the
 *   job.
 *
 * The fix:
 *   (a) `rollbackCheckoutOrder()` refuses COD unless a caller
 *       EXPLICITLY opts in (`allowCodCancellation`, default false);
 *   (b) `expireUnpaidOrderIfExpired()` refuses COD outright;
 *   (c) the checkout cleanup neither selects COD nor opts in;
 *   (d) an explicit customer self-cancel still opts in.
 *
 * Untouched on purpose: NON-COD flow, admin cancellation, refund flow,
 * COD `paymentStatus = UNPAID`, reconcile COD exclusion and the worker
 * `CANCELLED` guard (NOT bypassed).
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

type RawCall = { sql: string; values: unknown[] };

let capturedCalls: RawCall[] = [];

const mockTx = {
    // rollbackCheckoutOrder's atomic CAS. Returning 0 means the CAS
    // matched nothing, so the rollback early-returns right after it.
    $executeRaw: jest.fn(),
    order: {
        findUnique: jest.fn(),
    },
};

const mockPrisma = {
    order: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
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

import {
    rollbackCheckoutOrder,
    cancelOwnPendingOrder,
    cleanupPendingCheckoutOrders,
} from "@/lib/checkout";
import { expireUnpaidOrderIfExpired } from "@/lib/payment/order-payment";

const ONE_HOUR_MS = 60 * 60 * 1000;

function primeMocks(): void {
    capturedCalls = [];

    mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
        if (typeof arg === "function") {
            return (arg as (tx: unknown) => unknown)(mockTx);
        }
        return Promise.all(arg as Promise<unknown>[]);
    });

    mockTx.$executeRaw.mockImplementation(
        (strings: TemplateStringsArray, ...values: unknown[]) => {
            capturedCalls.push({
                sql: Array.isArray(strings)
                    ? strings.join(" @@ ")
                    : String(strings),
                values,
            });
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
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0].sql).toContain("paymentMethod <> 'COD'");
        // ...because the explicit opt-in defaults to false (0).
        expect(capturedCalls[0].values).toContain(0);
        expect(capturedCalls[0].values).not.toContain(1);
    });

    it("rollbackCheckoutOrder can still cancel a COD order when explicitly allowed", async () => {
        await rollbackCheckoutOrder(969, { allowCodCancellation: true });

        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0].values).toContain(1);
    });

    it("when the CAS does not match, rollback does NOT fall through and cancel", async () => {
        await rollbackCheckoutOrder(969);

        // affectedRows === 0 → early return, no findUnique + no final
        // order.update(CANCELLED). A COD order therefore stays intact.
        expect(mockTx.order.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
});

/* ==========================================
 * BEHAVIOUR — checkout cleanup
 * ========================================== */

describe("checkout cleanup can never cancel a COD order", () => {
    it("only ever queries non-COD PENDING/PENDING orders", async () => {
        mockPrisma.order.findMany.mockResolvedValue([]);

        await cleanupPendingCheckoutOrders("user-1");

        expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    userId: "user-1",
                    paymentMethod: {
                        in: ["BANK_TRANSFER", "E_WALLET", "QRIS"],
                    },
                    status: "PENDING",
                    paymentStatus: "PENDING",
                }),
            })
        );
    });

    it("defense-in-depth: even a COD order fed to rollback is not cancelled", async () => {
        mockPrisma.order.findMany.mockResolvedValue([
            {
                id: 969,
                orderNumber: "ORD-969",
                paymentNo: null,
                paymentUrl: null,
                paymentExpiresAt: null,
            },
        ]);

        await cleanupPendingCheckoutOrders("user-1");

        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0].values).toContain(969);
        expect(capturedCalls[0].sql).toContain("paymentMethod <> 'COD'");
        // Cleanup never opts in (0 = false).
        expect(capturedCalls[0].values).not.toContain(1);
    });
});

/* ==========================================
 * BEHAVIOUR — explicit customer cancellation
 * ========================================== */

describe("explicit customer cancellation stays safe for COD", () => {
    it("a COD order that is still UNPAID is NOT cancellable by the customer", async () => {
        mockPrisma.order.findFirst.mockResolvedValue({
            id: 969,
            status: "PENDING",
            paymentStatus: "UNPAID",
            paymentMethod: "COD",
        });

        const result = await cancelOwnPendingOrder("user-1", 969);

        expect(result).toEqual({ ok: false, reason: "NOT_CANCELLABLE" });
        // No rollback at all → COD order untouched.
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
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

        expect(section).toContain('"BANK_TRANSFER"');
        expect(section).toContain('"QRIS"');
        expect(section).not.toContain("allowCodCancellation");
    });

    it("the COD checkout itself never triggers cleanup", () => {
        const start = checkoutLib.indexOf(
            "export async function createCheckoutOrder("
        );
        const end = checkoutLib.indexOf(
            "export async function rollbackCheckoutOrder("
        );
        const section = checkoutLib.substring(start, end);

        // cleanup is skipped for COD at the call site
        expect(section).toContain('input.paymentMethod !==\n        "COD"');
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

    it("a COD order is never registered with the online payment provider (no webhook can target it)", () => {
        // COD never reaches the iPaymu provider: the create-payment route
        // only accepts non-COD methods, and the notification routes look
        // orders up by the unique `orderNumber`.
        const ipaymuRoute = readFile("app/api/payment/ipaymu/route.ts");
        expect(ipaymuRoute).toContain("allowedPaymentMethods");
        expect(ipaymuRoute).toContain('"BANK_TRANSFER"');
        expect(ipaymuRoute).toContain('"QRIS"');
        expect(ipaymuRoute).not.toContain('"COD",\n        ]');

        const ipaymuWebhook = readFile(
            "app/api/payment/ipaymu/notification/route.ts"
        );
        expect(ipaymuWebhook).toContain("where: {\n                    orderNumber,\n                }");

        const midtransWebhook = readFile(
            "app/api/payment/midtrans/notification/route.ts"
        );
        expect(midtransWebhook).toContain("where: {\n                        orderNumber,\n                    }");
    });
});
