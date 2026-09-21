/**
 * ==========================================
 * iPAYMU WEBHOOK HARDENING TESTS
 * ==========================================
 *
 * Local, provider-mocked proof for:
 *   BLOCKER 1 — header compatibility (X-Signature is the only
 *               required/verified header; X-Timestamp/X-External-ID
 *               are optional and must not gate settlement).
 *   Amount integrity — a success MUST carry a matching product
 *               total; an unverifiable amount fails closed.
 *   Replay/idempotency — duplicate success is a no-op.
 *
 * NOTE: iPaymu's real header set is PRODUCTION PROVIDER UNVERIFIED.
 * These tests prove OUR route behavior for every header combination,
 * not what the provider sends.
 */

jest.mock("@/lib/prisma", () => {
    const order = {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
    };
    const cart = { findUnique: jest.fn(), create: jest.fn() };
    const cartItem = {
        deleteMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
    };
    const orderItem = { findMany: jest.fn() };
    const refund = { findUnique: jest.fn(), create: jest.fn() };

    const tx = {
        $executeRaw: jest.fn(),
        order,
        cart,
        cartItem,
        orderItem,
        refund,
    };

    return {
        prisma: {
            order,
            cart,
            cartItem,
            orderItem,
            refund,
            $executeRaw: jest.fn(),
            $transaction: jest.fn(async (fn: any) => fn(tx)),
            __tx: tx,
        },
    };
});

jest.mock("@/lib/order-stock", () => ({
    releaseStockAndVoucherForOrder: jest.fn(),
}));

jest.mock("@/lib/refund", () => ({
    executeRefundCompletion: jest.fn(),
    transitionRefundForWebhook: jest.fn(),
}));

jest.mock("@/lib/affiliate/cancel-commission", () => ({
    cancelCommissionForOrder: jest.fn(),
}));

jest.mock("@/lib/marketing/shipping-discount", () => ({
    releaseShippingDiscountForOrder: jest.fn(),
}));

jest.mock("@/lib/notification/order-status-handler", () => ({
    onOrderStatusChanged: jest.fn(async () => undefined),
}));

jest.mock("@/lib/checkout", () => ({
    rollbackCheckoutOrder: jest.fn(async () => undefined),
    createCheckoutOrder: jest.fn(),
    cancelOwnPendingOrder: jest.fn(),
}));

import { NextRequest } from "next/server";

const { prisma } = require("@/lib/prisma") as any;
const {
    releaseStockAndVoucherForOrder,
} = require("@/lib/order-stock") as any;

import {
    computeCanonicalJson,
    computeWebhookSignature,
} from "@/lib/payment/ipaymu";
import { resetIpaymuConfigCache } from "@/lib/payment/config";

const SANDBOX_VA = "1179000899";

function webhookBody(fields: Record<string, string>): string {
    return new URLSearchParams(fields).toString();
}

type HeaderMode =
    | { kind: "all" }
    | { kind: "signature-only" }
    | { kind: "no-signature" }
    | { kind: "bad-signature" }
    | { kind: "none" };

function signedWebhook(
    fields: Record<string, string>,
    mode: HeaderMode = { kind: "all" }
): NextRequest {
    const body = webhookBody(fields);
    const signature = computeWebhookSignature(
        computeCanonicalJson(fields),
        SANDBOX_VA
    );

    const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
    };

    if (mode.kind === "all") {
        headers["x-signature"] = signature;
        headers["x-timestamp"] = "20260918123456";
        headers["x-external-id"] = fields.reference_id ?? "ext";
    } else if (mode.kind === "signature-only") {
        headers["x-signature"] = signature;
    } else if (mode.kind === "bad-signature") {
        headers["x-signature"] = "deadbeef";
        headers["x-timestamp"] = "20260918123456";
        headers["x-external-id"] = fields.reference_id ?? "ext";
    } else if (mode.kind === "no-signature") {
        headers["x-timestamp"] = "20260918123456";
        headers["x-external-id"] = fields.reference_id ?? "ext";
    }

    return new NextRequest(
        "https://shop.example.com/api/payment/ipaymu/notification",
        { method: "POST", headers, body }
    );
}

function pendingOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 101,
        userId: "user-1",
        orderNumber: "PAY-CART-101",
        status: "PENDING",
        paymentStatus: "PENDING",
        total: 100000,
        paymentReference: "PAY-CART-101",
        shippingDiscountId: null,
        paidAt: null,
        items: [],
        ...overrides,
    };
}

async function webhookHandler() {
    return import("@/app/api/payment/ipaymu/notification/route");
}

beforeAll(() => {
    process.env.PAYMENT_ENVIRONMENT = "sandbox";
    process.env.IPAYMU_SANDBOX_VA = SANDBOX_VA;
    process.env.IPAYMU_SANDBOX_API_KEY = "sandbox-api-key-1234567890";
    process.env.IPAYMU_SANDBOX_BASE_URL = "https://sandbox.ipaymu.com";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
});

beforeEach(() => {
    jest.clearAllMocks();
    resetIpaymuConfigCache();
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) =>
        fn(prisma.__tx)
    );
});

const SUCCESS_FIELDS = {
    reference_id: "PAY-CART-101",
    status_code: "1",
    sub_total: "100000",
    trx_id: "999",
};

describe("BLOCKER 1 — webhook header compatibility", () => {
    test("signature-only (no X-Timestamp/X-External-ID) still settles", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(pendingOrder());
        prisma.__tx.$executeRaw.mockResolvedValue(1);

        const { POST } = await webhookHandler();
        const response = await POST(
            signedWebhook(SUCCESS_FIELDS, { kind: "signature-only" })
        );

        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.success).toBe(true);
        // Settlement CAS actually ran.
        expect(prisma.__tx.$executeRaw).toHaveBeenCalled();
    });

    test("all three headers + bad signature → 401, no DB access", async () => {
        const { POST } = await webhookHandler();
        const response = await POST(
            signedWebhook(SUCCESS_FIELDS, { kind: "bad-signature" })
        );

        expect(response.status).toBe(401);
        expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });

    test("timestamp/external-id present but X-Signature missing → 401", async () => {
        const { POST } = await webhookHandler();
        const response = await POST(
            signedWebhook(SUCCESS_FIELDS, { kind: "no-signature" })
        );

        expect(response.status).toBe(401);
        expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });

    test("no headers at all → 401", async () => {
        const { POST } = await webhookHandler();
        const response = await POST(
            signedWebhook(SUCCESS_FIELDS, { kind: "none" })
        );

        expect(response.status).toBe(401);
    });

    test("replayed success is an idempotent no-op (CAS returns 0)", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(
            pendingOrder({ status: "PAID", paymentStatus: "PAID" })
        );
        prisma.__tx.$executeRaw.mockResolvedValue(0);

        const { POST } = await webhookHandler();
        const response = await POST(
            signedWebhook(SUCCESS_FIELDS, { kind: "signature-only" })
        );

        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.success).toBe(true);
        expect(releaseStockAndVoucherForOrder).not.toHaveBeenCalled();
        expect(prisma.__tx.cartItem.deleteMany).not.toHaveBeenCalled();
    });
});

describe("Amount integrity (settlement only)", () => {
    test("success with correct sub_total settles", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(pendingOrder());
        prisma.__tx.$executeRaw.mockResolvedValue(1);

        const { POST } = await webhookHandler();
        const response = await POST(
            signedWebhook(SUCCESS_FIELDS, { kind: "signature-only" })
        );

        expect(response.status).toBe(200);
        expect(prisma.__tx.$executeRaw).toHaveBeenCalled();
    });

    test("success with mismatched amount → 400, no settlement", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(pendingOrder());

        const { POST } = await webhookHandler();
        const response = await POST(
            signedWebhook(
                {
                    reference_id: "PAY-CART-101",
                    status_code: "1",
                    sub_total: "1",
                    trx_id: "999",
                },
                { kind: "signature-only" }
            )
        );

        expect(response.status).toBe(400);
        expect(prisma.__tx.$executeRaw).not.toHaveBeenCalled();
    });

    test("success with NO amount field → 400 (fail closed)", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(pendingOrder());

        const { POST } = await webhookHandler();
        const response = await POST(
            signedWebhook(
                {
                    reference_id: "PAY-CART-101",
                    status_code: "1",
                    trx_id: "999",
                },
                { kind: "signature-only" }
            )
        );

        expect(response.status).toBe(400);
        expect(prisma.__tx.$executeRaw).not.toHaveBeenCalled();
    });

    test("amount check falls back to total when sub_total/amount absent", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(pendingOrder());
        prisma.__tx.$executeRaw.mockResolvedValue(1);

        const { POST } = await webhookHandler();
        const response = await POST(
            signedWebhook(
                {
                    reference_id: "PAY-CART-101",
                    status_code: "1",
                    total: "100000",
                    trx_id: "999",
                },
                { kind: "signature-only" }
            )
        );

        expect(response.status).toBe(200);
        expect(prisma.__tx.$executeRaw).toHaveBeenCalled();
    });

    test("pending notification without amount is NOT rejected", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(pendingOrder());
        prisma.$executeRaw.mockResolvedValue(1);

        const { POST } = await webhookHandler();
        const response = await POST(
            signedWebhook(
                {
                    reference_id: "PAY-CART-101",
                    status_code: "0",
                    trx_id: "999",
                },
                { kind: "signature-only" }
            )
        );

        expect(response.status).toBe(200);
    });

    test("failed notification without amount releases stock", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(pendingOrder());
        prisma.__tx.$executeRaw.mockResolvedValue(1);

        const { POST } = await webhookHandler();
        const response = await POST(
            signedWebhook(
                {
                    reference_id: "PAY-CART-101",
                    status_code: "4",
                    trx_id: "999",
                },
                { kind: "signature-only" }
            )
        );

        expect(response.status).toBe(200);
        expect(releaseStockAndVoucherForOrder).toHaveBeenCalledTimes(1);
    });
});
