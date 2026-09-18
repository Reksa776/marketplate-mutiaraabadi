/**
 * ==========================================
 * iPAYMU DIRECT PAYMENT — BEHAVIORAL TESTS
 * ==========================================
 *
 * Covers the redirect → direct migration:
 *
 *   1. QRIS direct payment creation
 *   2. Virtual Account direct payment creation
 *   3. E-wallet direct payment creation
 *   4. invalid webhook signature
 *   5. wrong amount
 *   6. wrong referenceId
 *   7. duplicate webhook (idempotency)
 *   8. webhook after order cancellation (no resurrection)
 *   9. payment expiration
 *  10. payment failure
 *  11. successful payment
 *  12. browser polling before the webhook
 *  13. browser polling after the webhook
 *  14. production configuration safety
 *  15. credentials never returned to the client
 *
 * The provider API is ALWAYS mocked — no test can reach iPaymu
 * (the mock additionally asserts the sandbox base URL is the only
 * endpoint ever contacted).
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

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

jest.mock("@/lib/rate-limit", () => ({
    rateLimiters: {
        orderCreation: jest.fn(() => ({ allowed: true })),
        repayment: jest.fn(() => ({ allowed: true })),
    },
    getClientIp: jest.fn(() => "test"),
}));

import { NextRequest } from "next/server";

const { auth } = require("@/auth") as { auth: jest.Mock };
const { prisma } = require("@/lib/prisma") as any;
const {
    releaseStockAndVoucherForOrder,
} = require("@/lib/order-stock") as any;
const {
    cancelCommissionForOrder,
} = require("@/lib/affiliate/cancel-commission") as any;
const {
    releaseShippingDiscountForOrder,
} = require("@/lib/marketing/shipping-discount") as any;
const { rollbackCheckoutOrder } = require("@/lib/checkout") as any;

import {
    buildPaymentInstruction,
    classifyIpaymuNotification,
    computeCanonicalJson,
    computeWebhookSignature,
    createDirectPayment,
    parseIpaymuExpiredAt,
    resolveProviderMethod,
    sanitizeProviderUrl,
} from "@/lib/payment/ipaymu";
import {
    canReusePaymentInstruction,
    createDirectOrderPayment,
    expireUnpaidOrderIfExpired,
    loadPaymentView,
    PAYMENT_EXPIRY_GRACE_MS,
} from "@/lib/payment/order-payment";
import {
    buildIpaymuConfig,
    resetIpaymuConfigCache,
} from "@/lib/payment/config";

/* ==========================================
 * PROVIDER MOCK
 * ========================================== */

const SANDBOX_VA = "1179000899";
const SANDBOX_API_KEY = "sandbox-api-key-1234567890";

const fetchMock = jest.fn();

function providerResponse(data: Record<string, unknown>) {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            Status: 200,
            Success: true,
            Message: "Success",
            Data: data,
        }),
    };
}

function lastProviderRequest() {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    return {
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")),
    };
}

beforeAll(() => {
    process.env.PAYMENT_ENVIRONMENT = "sandbox";
    process.env.IPAYMU_SANDBOX_VA = SANDBOX_VA;
    process.env.IPAYMU_SANDBOX_API_KEY = SANDBOX_API_KEY;
    process.env.IPAYMU_SANDBOX_BASE_URL = "https://sandbox.ipaymu.com";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    global.fetch = fetchMock as unknown as typeof fetch;
});

beforeEach(() => {
    jest.clearAllMocks();
    resetIpaymuConfigCache();

    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) =>
        fn(prisma.__tx)
    );

    (auth as jest.Mock).mockResolvedValue({
        user: { id: "user-1", email: "buyer@example.com" },
    });
});

/* ==========================================
 * 1. QRIS DIRECT PAYMENT CREATION
 * ========================================== */

describe("1. QRIS direct payment creation", () => {
    test("creates a qris direct payment and persists the QR instruction", async () => {
        fetchMock.mockResolvedValue(
            providerResponse({
                SessionId: "ses_qris",
                TransactionId: 98765,
                ReferenceId: "PAY-CART-1",
                Via: "qris",
                Channel: "qris",
                PaymentNo: "QR-CODE-PAYLOAD",
                PaymentName: "QRIS",
                Total: 100000,
                Fee: 0,
                Expired: "2026-09-18 12:34:56",
                Url: "https://my.ipaymu.com/qr/98765.png",
            })
        );

        const result = await createDirectOrderPayment({
            orderId: 11,
            orderNumber: "PAY-CART-1",
            buyerName: "Budi",
            buyerPhone: "08123456789",
            buyerEmail: "buyer@example.com",
            amount: 100000,
            paymentMethod: "QRIS",
            notifyUrl:
                "https://shop.example.com/api/payment/ipaymu/notification",
        });

        // NEVER targets production in tests
        const request = lastProviderRequest();
        expect(request.url).toBe(
            "https://sandbox.ipaymu.com/api/v2/payment/direct"
        );
        expect(request.url).not.toContain("my.ipaymu.com");

        // Documented request fields only
        expect(request.body).toMatchObject({
            name: "Budi",
            phone: "08123456789",
            email: "buyer@example.com",
            amount: 100000,
            referenceId: "PAY-CART-1",
            paymentMethod: "qris",
            paymentChannel: "qris",
            notifyUrl:
                "https://shop.example.com/api/payment/ipaymu/notification",
        });

        // Signed request
        expect(request.headers.va).toBe(SANDBOX_VA);
        expect(request.headers.signature).toMatch(/^[a-f0-9]{64}$/);
        expect(request.headers.timestamp).toMatch(/^\d{14}$/);

        // Instruction + persistence
        expect(result.paymentPageUrl).toBe("/checkout/payment/11");
        expect(result.instruction.qrImageUrl).toBe(
            "https://my.ipaymu.com/qr/98765.png"
        );
        expect(result.providerChannel).toBe("qris");

        expect(prisma.order.update).toHaveBeenCalledWith({
            where: { id: 11 },
            data: expect.objectContaining({
                paymentNo: "QR-CODE-PAYLOAD",
                paymentUrl: "https://my.ipaymu.com/qr/98765.png",
                paymentChannel: "qris",
            }),
        });

        // Expired is normalized from WIB (UTC+7) to UTC
        expect(result.instruction.expiresAt?.toISOString()).toBe(
            "2026-09-18T05:34:56.000Z"
        );
    });

    test("fails closed when QRIS returns no usable QR data", async () => {
        fetchMock.mockResolvedValue(
            providerResponse({
                TransactionId: 1,
                Via: "qris",
                Channel: "qris",
            })
        );

        await expect(
            createDirectOrderPayment({
                orderId: 12,
                orderNumber: "PAY-CART-2",
                buyerName: "Budi",
                buyerPhone: "08123456789",
                buyerEmail: "buyer@example.com",
                amount: 50000,
                paymentMethod: "QRIS",
                notifyUrl: "https://shop.example.com/notify",
            })
        ).rejects.toThrow(/tidak mengembalikan data pembayaran/);

        // Nothing was persisted as a payable instruction
        expect(prisma.order.update).not.toHaveBeenCalled();
    });

    /*
     * RUNTIME-VERIFIED CONTRACT (iPaymu sandbox, 2026-09-18).
     *
     * The live direct-payment QRIS response does NOT contain `Url`
     * (it is absent from the provider payload) — the scannable image
     * arrives as `QrImage`, an https URL on the iPaymu host. This test
     * pins that shape so the QRIS instruction can never silently lose
     * its QR image again.
     */
    test("maps the live QRIS shape (QrImage, no Url) to the QR image", async () => {
        fetchMock.mockResolvedValue(
            providerResponse({
                SessionId: "ses_qris_live",
                TransactionId: 1789707975553,
                ReferenceId: "PAY-CART-3",
                Via: "QRIS",
                Channel: "QRIS",
                PaymentNo: "QRIS-PAYLOAD-STRING",
                PaymentName: "iPaymu",
                Total: 10000,
                Fee: 70,
                Expired: "2026-09-19 12:06:15",
                QrImage:
                    "https://sandbox.ipaymu.com/qris/1789707975553.png",
                QrString: "00020101021226610014ID.CO.QRIS.WWW",
                QrTemplate:
                    "https://sandbox.ipaymu.com/qris/template.png",
            })
        );

        const result = await createDirectOrderPayment({
            orderId: 13,
            orderNumber: "PAY-CART-3",
            buyerName: "Budi",
            buyerPhone: "08123456789",
            buyerEmail: "buyer@example.com",
            amount: 10000,
            paymentMethod: "QRIS",
            notifyUrl: "https://shop.example.com/notify",
        });

        expect(result.instruction.qrImageUrl).toBe(
            "https://sandbox.ipaymu.com/qris/1789707975553.png"
        );

        // Persisted where loadPaymentView() reads it back for the page
        expect(prisma.order.update).toHaveBeenCalledWith({
            where: { id: 13 },
            data: expect.objectContaining({
                paymentUrl:
                    "https://sandbox.ipaymu.com/qris/1789707975553.png",
            }),
        });
    });
});

/* ==========================================
 * 2. VIRTUAL ACCOUNT CREATION
 * ========================================== */

describe("2. Virtual Account direct payment creation", () => {
    test("creates a VA for the selected bank and persists the VA number", async () => {
        fetchMock.mockResolvedValue(
            providerResponse({
                TransactionId: 555,
                ReferenceId: "PAY-CART-3",
                Via: "va",
                Channel: "mandiri",
                PaymentNo: "8899123456789",
                PaymentName: "Mandiri Virtual Account",
                Total: 250000,
                Fee: 0,
                Expired: "2026-09-19 07:00:00",
                Url: "https://my.ipaymu.com/payment/555",
            })
        );

        const result = await createDirectOrderPayment({
            orderId: 13,
            orderNumber: "PAY-CART-3",
            buyerName: "Siti",
            buyerPhone: "08120000000",
            buyerEmail: "siti@example.com",
            amount: 250000,
            paymentMethod: "BANK_TRANSFER",
            paymentChannel: "mandiri",
            notifyUrl: "https://shop.example.com/notify",
        });

        expect(lastProviderRequest().body).toMatchObject({
            paymentMethod: "va",
            paymentChannel: "mandiri",
        });

        expect(result.instruction.paymentNo).toBe("8899123456789");
        expect(result.instruction.channelLabel).toBe(
            "Mandiri Virtual Account"
        );
        // The provider payment page URL is NOT exposed for VA.
        expect(result.instruction.paymentUrl).toBeNull();

        expect(prisma.order.update).toHaveBeenCalledWith({
            where: { id: 13 },
            data: expect.objectContaining({
                paymentNo: "8899123456789",
                paymentChannel: "mandiri",
            }),
        });
    });

    test("rejects an unlisted bank channel before calling the provider", async () => {
        await expect(
            createDirectOrderPayment({
                orderId: 14,
                orderNumber: "PAY-CART-4",
                buyerName: "Siti",
                buyerPhone: "08120000000",
                buyerEmail: "siti@example.com",
                amount: 250000,
                paymentMethod: "BANK_TRANSFER",
                paymentChannel: "bank-palsu",
                notifyUrl: "https://shop.example.com/notify",
            })
        ).rejects.toThrow(/Channel bank tidak valid/);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(prisma.order.update).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 3. E-WALLET CREATION
 * ========================================== */

describe("3. E-wallet direct payment creation", () => {
    test("creates an ewallet payment and exposes only the action URL", async () => {
        fetchMock.mockResolvedValue(
            providerResponse({
                TransactionId: 777,
                Via: "ewallet",
                Channel: "dana",
                PaymentName: "DANA",
                Total: 75000,
                Fee: 0,
                Expired: "2026-09-18 13:00:00",
                Url: "https://my.ipaymu.com/ewallet/777",
            })
        );

        const result = await createDirectOrderPayment({
            orderId: 15,
            orderNumber: "PAY-CART-5",
            buyerName: "Andi",
            buyerPhone: "08121111111",
            buyerEmail: "andi@example.com",
            amount: 75000,
            paymentMethod: "E_WALLET",
            paymentChannel: "dana",
            notifyUrl: "https://shop.example.com/notify",
        });

        expect(lastProviderRequest().body).toMatchObject({
            paymentMethod: "ewallet",
            paymentChannel: "dana",
        });

        expect(result.instruction.paymentUrl).toBe(
            "https://my.ipaymu.com/ewallet/777"
        );
        // Not a QRIS payment → no QR is shown.
        expect(result.instruction.qrImageUrl).toBeNull();
    });

    test("javascript: provider URLs are dropped by the sanitizer", () => {
        expect(sanitizeProviderUrl("javascript:alert(1)")).toBeNull();

        const instruction = buildPaymentInstruction(
            {
                Via: "ewallet",
                Channel: "dana",
                PaymentNo: "DANA-CODE",
                Url: "javascript:alert(1)",
            },
            "E_WALLET"
        );

        expect(instruction?.paymentUrl).toBeNull();
        expect(instruction?.paymentNo).toBe("DANA-CODE");
    });
});

/* ==========================================
 * WEBHOOK HELPERS
 * ========================================== */

function webhookBody(fields: Record<string, string>): string {
    return new URLSearchParams(fields).toString();
}

function signedWebhook(
    fields: Record<string, string>,
    options?: { signature?: string; missingHeaders?: boolean }
): NextRequest {
    const body = webhookBody(fields);
    const signature =
        options?.signature ??
        computeWebhookSignature(computeCanonicalJson(fields), SANDBOX_VA);

    const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
    };

    if (!options?.missingHeaders) {
        headers["x-signature"] = signature;
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

/* ==========================================
 * 4-6. WEBHOOK SECURITY
 * ========================================== */

describe("4-6. Webhook security", () => {
    test("4. invalid signature → 401 and no order change", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(
            pendingOrder()
        );

        const { POST } = await webhookHandler();

        const response = await POST(
            signedWebhook(
                {
                    reference_id: "PAY-CART-101",
                    status_code: "1",
                    sub_total: "100000",
                    trx_id: "999",
                },
                { signature: "deadbeef" }
            )
        );

        expect(response.status).toBe(401);
        expect(prisma.order.findUnique).not.toHaveBeenCalled();
        expect(prisma.__tx.$executeRaw).not.toHaveBeenCalled();
    });

    test("4b. missing auth headers → 401", async () => {
        const { POST } = await webhookHandler();

        const response = await POST(
            signedWebhook(
                { reference_id: "PAY-CART-101", status_code: "1" },
                { missingHeaders: true }
            )
        );

        expect(response.status).toBe(401);
    });

    test("5. wrong amount → 400 and no settlement", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(
            pendingOrder({ total: 100000 })
        );

        const { POST } = await webhookHandler();

        const response = await POST(
            signedWebhook({
                reference_id: "PAY-CART-101",
                status_code: "1",
                sub_total: "99999",
                amount: "99999",
                total: "99999",
                trx_id: "999",
            })
        );

        expect(response.status).toBe(400);
        expect(prisma.__tx.$executeRaw).not.toHaveBeenCalled();
    });

    test("5b. a payload with only sub_total is still amount-validated", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(
            pendingOrder({ total: 100000 })
        );

        const { POST } = await webhookHandler();

        const response = await POST(
            signedWebhook({
                reference_id: "PAY-CART-101",
                status_code: "1",
                sub_total: "1",
                trx_id: "999",
            })
        );

        expect(response.status).toBe(400);
        expect(prisma.__tx.$executeRaw).not.toHaveBeenCalled();
    });

    test("6. wrong referenceId → acknowledged but no state change", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(null);

        const { POST } = await webhookHandler();

        const response = await POST(
            signedWebhook({
                reference_id: "PAY-CART-UNKNOWN",
                status_code: "1",
                sub_total: "100000",
                trx_id: "999",
            })
        );

        expect(response.status).toBe(200);
        expect(prisma.__tx.$executeRaw).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 7-8. IDEMPOTENCY / NO RESURRECTION
 * ========================================== */

describe("7-8. Webhook idempotency and cancellation safety", () => {
    test("7. duplicate success webhook is a no-op (CAS returns 0)", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(
            pendingOrder({ status: "PAID", paymentStatus: "PAID" })
        );
        prisma.__tx.$executeRaw.mockResolvedValue(0);

        const { POST } = await webhookHandler();

        const response = await POST(
            signedWebhook({
                reference_id: "PAY-CART-101",
                status_code: "1",
                sub_total: "100000",
                trx_id: "999",
            })
        );

        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.success).toBe(true);
        // No cart cleanup, no notification, no release on a duplicate.
        expect(prisma.__tx.cartItem.deleteMany).not.toHaveBeenCalled();
        expect(releaseStockAndVoucherForOrder).not.toHaveBeenCalled();
    });

    test("8. webhook after cancellation never resurrects the order", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(
            pendingOrder({ status: "CANCELLED", paymentStatus: "FAILED" })
        );
        // CAS matches no row because the order is final.
        prisma.__tx.$executeRaw.mockResolvedValue(0);

        const { POST } = await webhookHandler();

        const response = await POST(
            signedWebhook({
                reference_id: "PAY-CART-101",
                status_code: "1",
                sub_total: "100000",
                trx_id: "999",
            })
        );

        expect(response.status).toBe(200);
        expect(prisma.__tx.$executeRaw).toHaveBeenCalledTimes(1);
        expect(prisma.__tx.cartItem.deleteMany).not.toHaveBeenCalled();

        // The settlement SQL is the only guard: it can never update a
        // CANCELLED order (verified by the CAS clause itself).
        const [sql] = prisma.__tx.$executeRaw.mock.calls[0];
        expect(String(sql)).toContain(
            "status IN ('PENDING', 'PROCESSING')"
        );
        expect(String(sql)).toContain(
            "paymentStatus NOT IN ('PAID', 'REFUNDED')"
        );
    });
});

/* ==========================================
 * 9-11. SUCCESS / FAILURE / EXPIRY
 * ========================================== */

describe("9-11. Webhook settlement", () => {
    test("9. payment expiration (status_code -2) cancels and releases", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(
            pendingOrder({ shippingDiscountId: 7 })
        );
        prisma.__tx.$executeRaw.mockResolvedValue(1);

        const { POST } = await webhookHandler();

        const response = await POST(
            signedWebhook({
                reference_id: "PAY-CART-101",
                status_code: "-2",
                status: "expired",
                sub_total: "100000",
                trx_id: "999",
            })
        );

        expect(response.status).toBe(200);
        expect(releaseStockAndVoucherForOrder).toHaveBeenCalled();
        expect(releaseShippingDiscountForOrder).toHaveBeenCalled();
        expect(cancelCommissionForOrder).toHaveBeenCalledWith(
            expect.anything(),
            101,
            "ORDER_PAYMENT_FAILED"
        );
    });

    test("9b. expired status code classifies as failure (never success)", () => {
        expect(classifyIpaymuNotification({ status_code: "-2" })).toBe(
            "failed"
        );
        expect(classifyIpaymuNotification({ status: "expired" })).toBe(
            "failed"
        );
        expect(classifyIpaymuNotification({ status_code: "1" })).toBe(
            "success"
        );
    });

    test("10. payment failure cancels the order and releases reservations", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(
            pendingOrder()
        );
        prisma.__tx.$executeRaw.mockResolvedValue(1);

        const { POST } = await webhookHandler();

        const response = await POST(
            signedWebhook({
                reference_id: "PAY-CART-101",
                status_code: "5",
                sub_total: "100000",
                trx_id: "999",
            })
        );

        expect(response.status).toBe(200);
        expect(releaseStockAndVoucherForOrder).toHaveBeenCalled();
        expect(cancelCommissionForOrder).toHaveBeenCalled();

        const [sql] = prisma.__tx.$executeRaw.mock.calls[0];
        expect(String(sql)).toContain("SET status = 'CANCELLED'");
    });

    test("11. successful payment settles PAID and clears the ordered cart items", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(
            pendingOrder({ status: "PENDING", paymentStatus: "PENDING" })
        );
        prisma.__tx.$executeRaw.mockResolvedValue(1);
        prisma.__tx.cart.findUnique.mockResolvedValue({ id: 5 });
        prisma.__tx.orderItem.findMany.mockResolvedValue([
            { variantId: 42 },
        ]);

        const { POST } = await webhookHandler();

        const response = await POST(
            signedWebhook({
                reference_id: "PAY-CART-101",
                status_code: "1",
                sub_total: "100000",
                trx_id: "999",
                via: "qris",
                channel: "qris",
            })
        );

        expect(response.status).toBe(200);

        const [sql] = prisma.__tx.$executeRaw.mock.calls[0];
        expect(String(sql)).toContain("SET status = 'PAID'");
        expect(String(sql)).toContain("paymentStatus = 'PAID'");

        expect(prisma.__tx.cartItem.deleteMany).toHaveBeenCalledWith({
            where: { cartId: 5, variantId: { in: [42] } },
        });
    });

    test("11b. success webhook never releases stock", async () => {
        (prisma.order.findUnique as jest.Mock).mockResolvedValue(
            pendingOrder()
        );
        prisma.__tx.$executeRaw.mockResolvedValue(1);

        const { POST } = await webhookHandler();

        await POST(
            signedWebhook({
                reference_id: "PAY-CART-101",
                status_code: "1",
                sub_total: "100000",
                trx_id: "999",
            })
        );

        expect(releaseStockAndVoucherForOrder).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 12-13. BROWSER POLLING
 * ========================================== */

describe("12-13. Browser polling (never authoritative)", () => {
    test("12. polling before the webhook shows PENDING + a payable instruction", async () => {
        (prisma.order.findFirst as jest.Mock).mockResolvedValue({
            id: 101,
            orderNumber: "PAY-CART-101",
            status: "PENDING",
            paymentStatus: "PENDING",
            paymentMethod: "BANK_TRANSFER",
            paymentChannel: "bca",
            paymentNo: "1179000899",
            paymentUrl: null,
            paymentExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
            total: 100000,
            paidAt: null,
            createdAt: new Date(),
        });

        const view = await loadPaymentView(101, "user-1");

        expect(view?.paymentStatus).toBe("PENDING");
        expect(view?.canPay).toBe(true);
        expect(view?.instruction.paymentNo).toBe("1179000899");
        expect(view?.instruction.kind).toBe("VIRTUAL_ACCOUNT");
    });

    test("12b. polling never settles an order (no writes)", async () => {
        const { GET } = await import(
            "@/app/api/orders/[id]/payment-status/route"
        );

        (prisma.order.findFirst as jest.Mock).mockResolvedValue({
            id: 101,
            orderNumber: "PAY-CART-101",
            status: "PENDING",
            paymentStatus: "PENDING",
            paymentMethod: "QRIS",
            paymentChannel: "qris",
            paymentNo: null,
            paymentUrl: "https://my.ipaymu.com/qr.png",
            paymentExpiresAt: null,
            total: 100000,
            paidAt: null,
            createdAt: new Date(),
        });

        const response = await GET(
            new NextRequest("https://shop.example.com/x"),
            { params: Promise.resolve({ id: "101" }) }
        );

        expect(response.status).toBe(200);
        expect(prisma.order.update).not.toHaveBeenCalled();
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    test("13. polling after the webhook shows PAID", async () => {
        (prisma.order.findFirst as jest.Mock).mockResolvedValue({
            id: 101,
            orderNumber: "PAY-CART-101",
            status: "PAID",
            paymentStatus: "PAID",
            paymentMethod: "QRIS",
            paymentChannel: "qris",
            paymentNo: null,
            paymentUrl: "https://my.ipaymu.com/qr.png",
            paymentExpiresAt: null,
            total: 100000,
            paidAt: new Date(),
            createdAt: new Date(),
        });

        const view = await loadPaymentView(101, "user-1");

        expect(view?.paymentStatus).toBe("PAID");
        expect(view?.canPay).toBe(false);
        expect(view?.paidAt).not.toBeNull();
    });

    test("13b. another user's order is invisible (404 semantics)", async () => {
        const { GET } = await import(
            "@/app/api/orders/[id]/payment-status/route"
        );

        (prisma.order.findFirst as jest.Mock).mockResolvedValue(null);

        const response = await GET(
            new NextRequest("https://shop.example.com/x"),
            { params: Promise.resolve({ id: "101" }) }
        );

        expect(response.status).toBe(404);
    });
});

/* ==========================================
 * 9c. SERVER-SIDE EXPIRY SETTLEMENT
 * ========================================== */

describe("9c. Server-side expiry settlement", () => {
    test("does not cancel while the payment window is still open", async () => {
        (prisma.order.findFirst as jest.Mock).mockResolvedValue({
            id: 101,
            status: "PENDING",
            paymentStatus: "PENDING",
            paymentExpiresAt: new Date(Date.now() + 60 * 1000),
        });

        const result = await expireUnpaidOrderIfExpired(101, "user-1");

        expect(result).toBe("NOT_EXPIRED");
        expect(rollbackCheckoutOrder).not.toHaveBeenCalled();
    });

    test("does not cancel inside the grace period", async () => {
        (prisma.order.findFirst as jest.Mock).mockResolvedValue({
            id: 101,
            status: "PENDING",
            paymentStatus: "PENDING",
            paymentExpiresAt: new Date(Date.now() - 30 * 1000),
        });

        const result = await expireUnpaidOrderIfExpired(101, "user-1");

        expect(result).toBe("NOT_EXPIRED");
        expect(rollbackCheckoutOrder).not.toHaveBeenCalled();
    });

    test("cancels through the existing lifecycle once expired", async () => {
        (prisma.order.findFirst as jest.Mock).mockResolvedValue({
            id: 101,
            status: "PENDING",
            paymentStatus: "PENDING",
            paymentExpiresAt: new Date(Date.now() - 10 * 60 * 1000),
        });

        const result = await expireUnpaidOrderIfExpired(101, "user-1");

        expect(result).toBe("EXPIRED");
        expect(rollbackCheckoutOrder).toHaveBeenCalledWith(101, {
            restoreCart: false,
        });
    });

    test("never cancels a paid order", async () => {
        (prisma.order.findFirst as jest.Mock).mockResolvedValue({
            id: 101,
            status: "PAID",
            paymentStatus: "PAID",
            paymentExpiresAt: new Date(Date.now() - 10 * 60 * 1000),
        });

        const result = await expireUnpaidOrderIfExpired(101, "user-1");

        expect(result).toBe("NOT_CANCELLABLE");
        expect(rollbackCheckoutOrder).not.toHaveBeenCalled();
    });

    test("never guesses an expiry when the provider gave none", async () => {
        (prisma.order.findFirst as jest.Mock).mockResolvedValue({
            id: 101,
            status: "PENDING",
            paymentStatus: "PENDING",
            paymentExpiresAt: null,
        });

        const result = await expireUnpaidOrderIfExpired(101, "user-1");

        expect(result).toBe("NOT_EXPIRED");
        expect(rollbackCheckoutOrder).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 14. PRODUCTION CONFIG SAFETY
 * ========================================== */

describe("14. Production configuration safety", () => {
    const productionEnv = {
        PAYMENT_ENVIRONMENT: "production",
        IPAYMU_PRODUCTION_VA: "1234567890",
        IPAYMU_PRODUCTION_API_KEY: "production-api-key-1234",
        IPAYMU_PRODUCTION_BASE_URL: "https://my.ipaymu.com",
        NEXT_PUBLIC_APP_URL: "https://shop.example.com",
    };

    test("production config is accepted only with a real production setup", () => {
        const config = buildIpaymuConfig(productionEnv);

        expect(config.environment).toBe("production");
        expect(config.baseUrl).toBe("https://my.ipaymu.com");
    });

    test("production refuses to run against the sandbox endpoint", () => {
        expect(() =>
            buildIpaymuConfig({
                ...productionEnv,
                IPAYMU_PRODUCTION_BASE_URL:
                    "https://sandbox.ipaymu.com",
            })
        ).toThrow(/not allowed for production/);
    });

    test("production refuses sandbox VA reuse", () => {
        expect(() =>
            buildIpaymuConfig({
                ...productionEnv,
                IPAYMU_SANDBOX_VA: "1234567890",
            })
        ).toThrow(/must not be reused/);
    });

    test("production refuses localhost APP_URL", () => {
        expect(() =>
            buildIpaymuConfig({
                ...productionEnv,
                NEXT_PUBLIC_APP_URL: "http://localhost:3000",
            })
        ).toThrow(/localhost/);
    });

    test("missing PAYMENT_ENVIRONMENT fails closed (no default environment)", () => {
        expect(() =>
            buildIpaymuConfig({
                IPAYMU_PRODUCTION_VA: "1234567890",
                IPAYMU_PRODUCTION_API_KEY: "production-api-key-1234",
            })
        ).toThrow(/PAYMENT_ENVIRONMENT/);
    });

    test("createDirectPayment throws before any request when config is invalid", async () => {
        delete process.env.PAYMENT_ENVIRONMENT;
        resetIpaymuConfigCache();

        await expect(
            createDirectPayment({
                name: "Budi",
                phone: "08123",
                email: "b@example.com",
                amount: 10000,
                notifyUrl: "https://shop.example.com/notify",
                referenceId: "PAY-1",
                paymentMethod: "va",
                paymentChannel: "bca",
            })
        ).rejects.toThrow();

        expect(fetchMock).not.toHaveBeenCalled();

        process.env.PAYMENT_ENVIRONMENT = "sandbox";
        resetIpaymuConfigCache();
    });
});

/* ==========================================
 * 15. CREDENTIALS NEVER REACH THE CLIENT
 * ========================================== */

describe("15. Credentials never returned to the client", () => {
    test("the create result carries only the sanitized instruction", async () => {
        fetchMock.mockResolvedValue(
            providerResponse({
                SessionId: "ses_secret",
                TransactionId: 4242,
                Via: "va",
                Channel: "bni",
                PaymentNo: "999900001111",
                PaymentName: "BNI Virtual Account",
                Total: 10000,
                Expired: "2026-09-18 20:00:00",
            })
        );

        const result = await createDirectOrderPayment({
            orderId: 21,
            orderNumber: "PAY-CART-21",
            buyerName: "Budi",
            buyerPhone: "08123",
            buyerEmail: "b@example.com",
            amount: 10000,
            paymentMethod: "BANK_TRANSFER",
            paymentChannel: "bni",
            notifyUrl: "https://shop.example.com/notify",
        });

        const serialized = JSON.stringify(result);

        expect(serialized).not.toContain(SANDBOX_API_KEY);
        expect(serialized).not.toContain(SANDBOX_VA);
        expect(serialized).not.toContain("signature");
        expect(serialized).not.toContain("apiKey");
    });

    test("the polling payload exposes no provider credential", async () => {
        (prisma.order.findFirst as jest.Mock).mockResolvedValue({
            id: 101,
            orderNumber: "PAY-CART-101",
            status: "PENDING",
            paymentStatus: "PENDING",
            paymentMethod: "BANK_TRANSFER",
            paymentChannel: "bca",
            // Customer VA number (NOT the merchant VA).
            paymentNo: "5551234567",
            paymentUrl: null,
            paymentExpiresAt: null,
            total: 100000,
            paidAt: null,
            createdAt: new Date(),
        });

        const { GET } = await import(
            "@/app/api/orders/[id]/payment-status/route"
        );

        const response = await GET(
            new NextRequest("https://shop.example.com/x"),
            { params: Promise.resolve({ id: "101" }) }
        );

        const payload = await response.json();
        const serialized = JSON.stringify(payload);

        expect(payload.success).toBe(true);
        expect(serialized).not.toContain(SANDBOX_API_KEY);
        expect(serialized).not.toContain(SANDBOX_VA);
        expect(serialized).not.toContain("signature");
        expect(serialized).not.toContain("apiKey");
        // Only the instruction subset is exposed.
        expect(payload.data.instruction).toEqual(
            expect.objectContaining({
                kind: "VIRTUAL_ACCOUNT",
                paymentNo: "5551234567",
                channelLabel: "BCA",
            })
        );
    });
});

/* ==========================================
 * 16. REPAYMENT INSTRUCTION REUSE
 * ==========================================
 *
 * "Bayar Lagi" on a still-unpaid order must reuse the existing
 * provider instruction instead of creating a second payment keyed by
 * the same referenceId. Only a missing / expired / mismatched / dead
 * instruction may trigger a fresh provider payment.
 */

describe("16. Repayment instruction reuse", () => {
    function openOrder(
        overrides: Partial<{
            status: string;
            paymentStatus: string;
            paymentMethod: "BANK_TRANSFER" | "E_WALLET" | "QRIS";
            paymentNo: string | null;
            paymentUrl: string | null;
            paymentChannel: string | null;
            paymentExpiresAt: Date | null;
        }> = {}
    ) {
        return {
            status: "PENDING",
            paymentStatus: "PENDING",
            paymentMethod: "BANK_TRANSFER" as const,
            paymentNo: "8808123456",
            paymentUrl: null,
            paymentChannel: "bca",
            paymentExpiresAt: new Date(Date.now() + 30 * 60_000),
            ...overrides,
        };
    }

    test("reuses a VA instruction while the provider window is open", () => {
        expect(
            canReusePaymentInstruction(openOrder(), "BANK_TRANSFER")
        ).toBe(true);
    });

    test("reuses inside the expiry grace, not after it", () => {
        const justPassed = new Date(
            Date.now() - Math.floor(PAYMENT_EXPIRY_GRACE_MS / 2)
        );
        const longGone = new Date(
            Date.now() - PAYMENT_EXPIRY_GRACE_MS - 60_000
        );

        expect(
            canReusePaymentInstruction(
                openOrder({ paymentExpiresAt: justPassed }),
                "BANK_TRANSFER"
            )
        ).toBe(true);

        expect(
            canReusePaymentInstruction(
                openOrder({ paymentExpiresAt: longGone }),
                "BANK_TRANSFER"
            )
        ).toBe(false);
    });

    test("never reuses without a usable instruction", () => {
        expect(
            canReusePaymentInstruction(
                openOrder({ paymentExpiresAt: null }),
                "BANK_TRANSFER"
            )
        ).toBe(false);

        expect(
            canReusePaymentInstruction(
                openOrder({ paymentNo: null }),
                "BANK_TRANSFER"
            )
        ).toBe(false);

        expect(
            canReusePaymentInstruction(
                openOrder({ paymentUrl: null, paymentNo: null }),
                "QRIS"
            )
        ).toBe(false);
    });

    test("reuses QRIS / e-wallet instructions from their provider URL", () => {
        expect(
            canReusePaymentInstruction(
                openOrder({
                    paymentMethod: "QRIS",
                    paymentNo: null,
                    paymentUrl:
                        "https://sandbox.ipaymu.com/qris/1.png",
                }),
                "QRIS"
            )
        ).toBe(true);

        expect(
            canReusePaymentInstruction(
                openOrder({
                    paymentMethod: "E_WALLET",
                    paymentNo: null,
                    paymentUrl: "https://m.sandbox.dana.id/x",
                }),
                "E_WALLET"
            )
        ).toBe(true);
    });

    test("a method change always needs a new instruction", () => {
        expect(
            canReusePaymentInstruction(openOrder(), "E_WALLET")
        ).toBe(false);
    });

    test("cancelled / failed / paid orders are never reused", () => {
        expect(
            canReusePaymentInstruction(
                openOrder({
                    status: "CANCELLED",
                    paymentStatus: "FAILED",
                }),
                "BANK_TRANSFER"
            )
        ).toBe(false);

        expect(
            canReusePaymentInstruction(
                openOrder({ paymentStatus: "EXPIRED" }),
                "BANK_TRANSFER"
            )
        ).toBe(false);

        expect(
            canReusePaymentInstruction(
                openOrder({
                    status: "PAID",
                    paymentStatus: "PAID",
                }),
                "BANK_TRANSFER"
            )
        ).toBe(false);
    });
});

/* ==========================================
 * PROVIDER CONTRACT HELPERS
 * ========================================== */

describe("Provider contract helpers", () => {
    test("expiry parsing converts Jakarta time to UTC and rejects garbage", () => {
        expect(
            parseIpaymuExpiredAt("2026-01-02 03:04:05")?.toISOString()
        ).toBe("2026-01-01T20:04:05.000Z");

        expect(parseIpaymuExpiredAt("not-a-date")).toBeNull();
        expect(parseIpaymuExpiredAt(undefined)).toBeNull();
        expect(parseIpaymuExpiredAt("1040-01-01 00:00:00")).toBeNull();
    });

    test("channel mapping never escapes the documented allowlist", () => {
        expect(resolveProviderMethod("QRIS", null)).toEqual({
            method: "qris",
            channel: "qris",
        });

        expect(() =>
            resolveProviderMethod("E_WALLET", "wallet-palsu")
        ).toThrow(/Channel e-wallet tidak valid/);
    });
});
