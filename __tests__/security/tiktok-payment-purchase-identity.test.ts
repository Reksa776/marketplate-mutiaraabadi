/**
 * ==========================================
 * TIKTOK PAYMENT-PATH PURCHASE IDENTITY
 * ==========================================
 *
 * Continues the /checkout/success fix: the two OTHER browser
 * CompletePayment paths must use the SAME authoritative Order → User
 * identity instead of only the session-driven store.
 *
 *   /checkout/payment/[id]            → GET /api/orders/[id]/payment-status
 *                                        → loadPaymentView().identity
 *   /checkout/payment-finish          → GET /api/payment/status
 *                                        → data.identity
 *
 * Both endpoints are session + ownership scoped and now hand the
 * client SHA-256 digests only; raw email/phone/userId never leave the
 * server. Every browser path then routes through the single existing
 * helper `trackAuthoritativeTikTokPurchase` (identify BEFORE track,
 * shared event id).
 *
 * No test contacts iPaymu or TikTok.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/prisma", () => {
    const order = {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
    };

    return {
        prisma: {
            order,
            $transaction: jest.fn(),
        },
    };
});

jest.mock("@/lib/checkout", () => ({
    rollbackCheckoutOrder: jest.fn(async () => undefined),
    createCheckoutOrder: jest.fn(),
    cancelOwnPendingOrder: jest.fn(),
}));

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

import { readFileSync } from "fs";
import { resolve } from "path";

import { NextRequest } from "next/server";

const { auth } = require("@/auth") as { auth: jest.Mock };
const { prisma } = require("@/lib/prisma") as {
    prisma: { order: { findFirst: jest.Mock } };
};

import { loadPaymentView } from "@/lib/payment/order-payment";
import {
    buildTikTokBrowserMatch,
} from "@/lib/analytics/tiktok-user-match";
import { GET as paymentStatusGET } from "@/app/api/payment/status/route";

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

function readCode(relativePath: string): string {
    return readFile(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

const RAW_EMAIL = "buyer@example.com";
const RAW_PHONE = "08123456789";
const USER_ID = "user_abc123";

function orderRow(
    overrides: Record<string, unknown> = {}
) {
    return {
        id: 101,
        orderNumber: "PAY-CART-101",
        status: "PENDING",
        paymentStatus: "PENDING",
        paymentMethod: "QRIS",
        paymentChannel: "qris",
        paymentNo: null,
        paymentUrl: "https://example.com/qris-page",
        qrString: "RAW-QRIS-PAYLOAD",
        paymentExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        total: "75000.00",
        paidAt: null,
        createdAt: new Date(),
        userId: USER_ID,
        phone: RAW_PHONE,
        user: {
            email: RAW_EMAIL,
            phone: RAW_PHONE,
        },
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    (auth as jest.Mock).mockResolvedValue({
        user: { id: "user-1" },
    });
    prisma.order.findFirst.mockResolvedValue(orderRow());
});

/* ==========================================
 * A. loadPaymentView — payment/[id] source
 * ========================================== */

describe("loadPaymentView exposes authoritative digests", () => {
    test("1. email + phone → both fields, correctly hashed", async () => {
        const view = await loadPaymentView(101, "user-1");

        expect(view?.identity).toEqual(
            buildTikTokBrowserMatch({
                email: RAW_EMAIL,
                phone: RAW_PHONE,
                externalId: USER_ID,
            })
        );

        expect(view?.identity.email).toMatch(
            /^[a-f0-9]{64}$/
        );
        expect(view?.identity.phone_number).toMatch(
            /^[a-f0-9]{64}$/
        );
        expect(view?.identity.external_id).toMatch(
            /^[a-f0-9]{64}$/
        );
    });

    test("2. email-only → phone_number omitted", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({
                phone: "",
                user: { email: RAW_EMAIL, phone: null },
            })
        );

        const view = await loadPaymentView(101, "user-1");

        expect(view?.identity.email).toBeDefined();
        expect(view?.identity).not.toHaveProperty(
            "phone_number"
        );
    });

    test("3. phone-only → email omitted", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({
                phone: RAW_PHONE,
                user: { email: null, phone: RAW_PHONE },
            })
        );

        const view = await loadPaymentView(101, "user-1");

        expect(view?.identity.phone_number).toBeDefined();
        expect(view?.identity).not.toHaveProperty("email");
    });

    test("4. no identifiers → empty identity (never fabricated)", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({
                userId: "",
                phone: "",
                user: { email: null, phone: null },
            })
        );

        const view = await loadPaymentView(101, "user-1");

        expect(view?.identity).toEqual({});
    });

    test("the read model never returns raw email/phone/userId", async () => {
        const view = await loadPaymentView(101, "user-1");

        const serialized = JSON.stringify(view);

        expect(serialized).not.toContain(RAW_EMAIL);
        expect(serialized).not.toContain(RAW_PHONE);
        expect(serialized).not.toContain(USER_ID);
    });
});

/* ==========================================
 * B. /api/payment/status — payment-finish source
 * ========================================== */

describe("GET /api/payment/status returns digest-only identity", () => {
    function request() {
        return new NextRequest(
            "http://test/api/payment/status?reference=PAY-CART-101"
        );
    }

    test("1/2/3. identity is built from Order → User", async () => {
        const response = await paymentStatusGET(request());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.identity).toEqual(
            buildTikTokBrowserMatch({
                email: RAW_EMAIL,
                phone: RAW_PHONE,
                externalId: USER_ID,
            })
        );
    });

    test("never leaks the raw identity columns", async () => {
        const response = await paymentStatusGET(request());
        const body = await response.json();

        expect(body.data).not.toHaveProperty("user");
        expect(body.data).not.toHaveProperty("phone");
        expect(body.data).not.toHaveProperty("userId");

        const serialized = JSON.stringify(body);

        expect(serialized).not.toContain(RAW_EMAIL);
        expect(serialized).not.toContain(RAW_PHONE);
        expect(serialized).not.toContain(USER_ID);
    });

    test("email-only / phone-only are conditional", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({
                phone: "",
                user: { email: RAW_EMAIL, phone: null },
            })
        );

        const emailOnly = await (
            await paymentStatusGET(request())
        ).json();

        expect(emailOnly.data.identity.email).toBeDefined();
        expect(emailOnly.data.identity).not.toHaveProperty(
            "phone_number"
        );

        prisma.order.findFirst.mockResolvedValue(
            orderRow({
                phone: RAW_PHONE,
                user: { email: null, phone: RAW_PHONE },
            })
        );

        const phoneOnly = await (
            await paymentStatusGET(request())
        ).json();

        expect(
            phoneOnly.data.identity.phone_number
        ).toBeDefined();
        expect(phoneOnly.data.identity).not.toHaveProperty(
            "email"
        );
    });

    test("unauthenticated → 401, no order read", async () => {
        (auth as jest.Mock).mockResolvedValue(null);

        const response = await paymentStatusGET(request());

        expect(response.status).toBe(401);
        expect(
            prisma.order.findFirst
        ).not.toHaveBeenCalled();
    });

    test("not owned / missing → 404", async () => {
        prisma.order.findFirst.mockResolvedValue(null);

        const response = await paymentStatusGET(request());

        expect(response.status).toBe(404);
    });
});

/* ==========================================
 * C. BOTH RESIDUAL PATHS USE THE SHARED HELPER
 * ========================================== */

describe("residual browser CompletePayment paths are consistent", () => {
    const paymentPage = readCode(
        "app/checkout/payment/[id]/page.tsx"
    );
    const finishPage = readCode(
        "app/checkout/payment-finish/payment-finish-content.tsx"
    );
    const successPage = readCode(
        "app/checkout/success/page.tsx"
    );

    test("10. every path routes through trackAuthoritativeTikTokPurchase", () => {
        for (const code of [
            paymentPage,
            finishPage,
        ]) {
            expect(code).toContain(
                "trackAuthoritativeTikTokPurchase"
            );
            expect(code).toContain(
                "whenTikTokReadyForEvents"
            );
        }

        /* /checkout/success routes through PurchaseTracker, which
         * itself calls the same helper. */
        expect(successPage).toContain("PurchaseTracker");
    });

    test("identity comes from the server response, not the client", () => {
        expect(paymentPage).toContain("view.identity");
        expect(finishPage).toContain("order.identity");
    });

    test("9. exactly one CompletePayment fires — no direct track left", () => {
        for (const code of [paymentPage, finishPage]) {
            /* No direct pixel call: the helper owns event + id. */
            expect(code).not.toContain("trackTikTokEvent(");
            expect(code).not.toContain("buildTikTokEventId(");
            expect(code).not.toContain("ttq.identify(");

            const calls = (
                code.match(
                    /trackAuthoritativeTikTokPurchase\(/g
                ) ?? []
            ).length;

            expect(calls).toBe(1);
        }
    });

    test("8. no raw PII on the client / in logs", () => {
        for (const code of [paymentPage, finishPage]) {
            expect(code).not.toContain("localStorage");
            expect(code).not.toContain(
                'searchParams.get("email")'
            );
            expect(code).not.toContain(
                'searchParams.get("phone")'
            );
            expect(code).not.toMatch(
                /console\.[a-z]+\([^)]*(email|phone)/i
            );
        }
    });

    test("the helper still gates identity before the event id", () => {
        const helper = readCode(
            "components/analytics/PurchaseTracker.tsx"
        );

        const identifyAt = helper.indexOf(
            "trackTikTokUserMatch("
        );
        const trackAt = helper.indexOf("trackTikTokEvent(");

        expect(identifyAt).toBeGreaterThan(-1);
        expect(trackAt).toBeGreaterThan(-1);
        expect(identifyAt).toBeLessThan(trackAt);
    });
});
