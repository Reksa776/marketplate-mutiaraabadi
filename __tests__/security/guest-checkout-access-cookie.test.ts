/**
 * ==========================================
 * GUEST CHECKOUT ACCESS COOKIE — REGRESSION TESTS
 * ==========================================
 *
 * THE BUG THIS SUITE PINS
 * -----------------------
 * `createCheckoutOrder` mints the guest access token and persists ONLY
 * its SHA-256 hash (`Order.guestAccessTokenHash` + the 30-day window),
 * returning the RAW token as `guestAccessToken`.
 *
 * Every order-creating route therefore HAS TO put THAT token in the
 * httpOnly `gos_<orderId>` cookie. The routes used to mint their OWN
 * token right before issuing the cookie:
 *
 *     const guestToken = userId ? null : generateGuestAccessToken();
 *     ...
 *     issueGuestOrderAccessCookie(response, result.order.id, guestToken);
 *
 * Nothing persisted that token's hash, so the cookie never matched the
 * order. The buyer was redirected to /checkout/success with a cookie the
 * server refused, and the page answered:
 *
 *     "Pesanan tidak ditemukan. Pastikan Anda membuka halaman ini di
 *      perangkat yang sama saat checkout, atau pulihkan pesanan dari
 *      halaman Pesanan Saya."
 *
 * ...even though the order, its stock reservation and its shipment job
 * had all been created successfully.
 *
 * WHAT IS ASSERTED
 * ----------------
 *   1. The cookie carries EXACTLY the token the checkout returned —
 *      byte for byte, for Cart, Buy Now and both iPaymu routes.
 *   2. That cookie token hashes to the value the order persisted, i.e.
 *      the access check the detail page/API performs really passes.
 *   3. An idempotent REPLAY (`duplicate: true`, no raw token) issues NO
 *      cookie, so it cannot clobber a working one.
 *   4. A logged-in buyer (no guest token) gets no guest cookie.
 *   5. The raw token never appears in a response body.
 *
 * Prisma, auth and the payment provider are mocked: no database, no
 * WhatsApp message and no payment request is made.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET ||
    "guest-checkout-access-cookie-test-secret";

/* A trusted proxy is configured so each test can use a UNIQUE client IP.
 * The limiters are real and in-memory; without a per-test bucket the
 * later cases would see 429 from the budget earlier cases consumed. */
process.env.TRUSTED_PROXY = "1";

/* Required by getAppOrigin() for the iPaymu routes' callback URLs. */
process.env.NEXT_PUBLIC_APP_URL = "http://localhost";

jest.mock("@/auth", () => ({
    auth: jest.fn(async () => null),
}));

jest.mock("next/headers", () => ({
    cookies: jest.fn(async () => ({
        get: () => undefined,
        getAll: () => [],
    })),
}));

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: {
            findUnique: jest.fn(async () => null),
            findFirst: jest.fn(async () => null),
            findMany: jest.fn(async () => []),
            update: jest.fn(async () => ({})),
        },
        user: {
            findUnique: jest.fn(async () => null),
        },
        shipmentJob: {
            createMany: jest.fn(async () => ({ count: 1 })),
            upsert: jest.fn(async () => ({})),
            deleteMany: jest.fn(async () => ({ count: 0 })),
        },
        $transaction: jest.fn(
            async (fn: (tx: unknown) => Promise<unknown>) =>
                fn({
                    order: {
                        updateMany: jest.fn(async () => ({
                            count: 0,
                        })),
                    },
                })
        ),
    },
}));

const mockCreateCheckoutOrder = jest.fn();
const mockRollbackCheckoutOrder = jest.fn();

jest.mock("@/lib/checkout", () => {
    const actual = jest.requireActual("@/lib/checkout");

    return {
        ...actual,
        createCheckoutOrder: (...args: unknown[]) =>
            mockCreateCheckoutOrder(...args),
        rollbackCheckoutOrder: (...args: unknown[]) =>
            mockRollbackCheckoutOrder(...args),
    };
});

const mockCreateDirectOrderPayment = jest.fn();

jest.mock("@/lib/payment/order-payment", () => {
    const actual = jest.requireActual(
        "@/lib/payment/order-payment"
    );

    return {
        ...actual,
        createDirectOrderPayment: (...args: unknown[]) =>
            mockCreateDirectOrderPayment(...args),
    };
});

jest.mock("@/lib/payment/config", () => {
    const actual = jest.requireActual("@/lib/payment/config");

    return {
        ...actual,
        getIpaymuConfig: () => ({
            environment: "sandbox",
            baseUrl: "https://sandbox.ipaymu.test",
            va: "1179000000000000",
            apiKey: "SANDBOX-API-KEY",
        }),
    };
});

import { NextRequest } from "next/server";

import { hashGuestAccessToken } from "@/lib/guest-identity";

import { POST as codOrdersPOST } from "@/app/api/orders/route";
import { POST as buyNowPOST } from "@/app/api/buy-now/route";
import { POST as ipaymuPOST } from "@/app/api/payment/ipaymu/route";
import { POST as buyNowIpaymuPOST } from "@/app/api/buy-now/ipaymu/route";

const ORDER_ID = 4242;
const ORDER_NUMBER = "ORD-REG-4242";
const OTHER_ORDER_ID = 4243;

/**
 * The raw token the checkout mints. Its hash is what a real checkout
 * would persist on the order, so a correct route MUST echo this exact
 * value back in the cookie.
 */
const MINTED_TOKEN = "minted-checkout-access-token-abcdefghijklmnopqrst";

const guestAddress = {
    recipientName: "Regression Guest",
    phone: "081200000001",
    email: "regression.guest@example.invalid",
    address: "Jl. Regresi No. 1",
    province: "DKI JAKARTA",
    city: "JAKARTA SELATAN",
    district: "KEBAYORAN BARU",
    subdistrict: "SENAYAN",
    postalCode: "12190",
};

let identityCounter = 0;

/**
 * A UNIQUE buyer contact per request.
 *
 * The guest COD caps are keyed on the hashed email/phone (NOT the IP —
 * that is the point of an identity bucket), so reusing one contact here
 * would make the later cases hit "3 COD orders per day" and report 429
 * instead of the cookie behaviour under test.
 */
function uniqueGuestAddress() {
    identityCounter += 1;

    return {
        ...guestAddress,
        email: `regression.guest.${identityCounter}@example.invalid`,
        phone: `0812${String(identityCounter).padStart(
            8,
            "0"
        )}`,
    };
}

const shipping = {
    provider: "MENGANTAR",
    courier: "jnt",
    service: "REG",
    cost: 12000,
};

/* ==========================================
 * FIXTURES
 * ========================================== */

/**
 * A checkout result as `createCheckoutOrder` really returns it for a
 * guest COD order: a synthetic order row, its items, the totals — and
 * the RAW guest access token whose hash was persisted.
 */
function checkoutResult(overrides: Record<string, unknown> = {}) {
    const price = 50000;

    return {
        order: {
            id: ORDER_ID,
            orderNumber: ORDER_NUMBER,
            userId: null,
            recipientName: guestAddress.recipientName,
            phone: guestAddress.phone,
            customerEmail: guestAddress.email,
            voucherCode: null,
            total: 62000,
        },
        checkoutItems: [
            {
                productId: 1,
                variantId: 2,
                productName: "Produk Regresi",
                variantName: "Varian",
                quantity: 1,
                price,
            },
        ],
        subtotal: Number(price),
        shippingCost: 12000,
        discount: 0,
        spinWheelDiscount: 0,
        grossAmount: Number(price) + 12000,
        cartId: 99,
        guestAccessToken: MINTED_TOKEN,
        requiresCodReview: false,
        duplicate: false,
        ...overrides,
    };
}

function paymentResult() {
    return {
        paymentPageUrl: "https://sandbox.ipaymu.test/pay/REG-4242",
        providerChannel: "qris",
        instruction: {
            channel: "qris",
            channelLabel: "QRIS",
            paymentNo: null,
            qrisPageUrl: "https://sandbox.ipaymu.test/qr/REG-4242",
            paymentUrl: null,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
    };
}

let ipCounter = 10;

function uniqueIp(): string {
    ipCounter += 1;

    return `203.0.113.${ipCounter}`;
}

function postJson(
    url: string,
    body: unknown,
    ip = uniqueIp()
): NextRequest {
    return new NextRequest(`http://localhost${url}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-forwarded-for": ip,
            /*
             * `host` is set explicitly: the same-origin guard compares
             * `Origin` against the Host header, and the CSRF rejection
             * would otherwise mask every assertion below.
             */
            origin: "http://localhost",
            host: "localhost",
        },
        body: JSON.stringify(body),
    });
}

function guestCookie(
    response: Response,
    orderId = ORDER_ID
): { raw: string; value: string } | null {
    const header = (
        response.headers as unknown as {
            getSetCookie?: () => string[];
        }
    ).getSetCookie?.() ?? [];

    const match = header.find((cookie) =>
        cookie.startsWith(`gos_${orderId}=`)
    );

    if (!match) {
        return null;
    }

    const pair = match.split(";")[0];
    const value = pair.slice(pair.indexOf("=") + 1).trim();

    return {
        raw: match,
        value: decodeURIComponent(value),
    };
}

beforeEach(() => {
    mockCreateCheckoutOrder.mockReset();
    mockRollbackCheckoutOrder.mockReset();
    mockCreateDirectOrderPayment.mockReset();

    mockCreateCheckoutOrder.mockResolvedValue(checkoutResult());
    mockCreateDirectOrderPayment.mockResolvedValue(paymentResult());
});

/* ==========================================
 * 1. CART + COD  (/api/orders)
 * ========================================== */

describe("POST /api/orders (Cart + COD) — guest access cookie", () => {
    test("issues the cookie with EXACTLY the token the checkout persisted", async () => {
        const response = await codOrdersPOST(
            postJson("/api/orders", {
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "COD",
            })
        );

        expect(response.status).toBe(201);

        const cookie = guestCookie(response);

        expect(cookie).not.toBeNull();

        /*
         * THE REGRESSION: a separately minted token would produce a
         * cookie that does not match the stored hash, and the buyer
         * would be locked out of the order they just placed.
         */
        expect(cookie!.value).toBe(
            `${ORDER_ID}.${MINTED_TOKEN}`
        );
    });

    test("the cookie token hashes to the value the order stored", async () => {
        const response = await codOrdersPOST(
            postJson("/api/orders", {
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "COD",
            })
        );

        const cookie = guestCookie(response);

        const token = cookie!.value.slice(
            cookie!.value.indexOf(".") + 1
        );

        /* This is the comparison the detail page/API performs. */
        expect(hashGuestAccessToken(token)).toBe(
            hashGuestAccessToken(MINTED_TOKEN)
        );
    });

    test("the cookie is httpOnly, SameSite=Lax, Path=/ with a 30-day maxAge", async () => {
        const response = await codOrdersPOST(
            postJson("/api/orders", {
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "COD",
            })
        );

        const cookie = guestCookie(response);

        expect(cookie!.raw).toMatch(/HttpOnly/i);
        expect(cookie!.raw).toMatch(/SameSite=lax/i);
        expect(cookie!.raw).toMatch(/Path=\//);
        expect(cookie!.raw).toMatch(/Max-Age=2592000/);
    });

    test("never returns the raw token in the response body", async () => {
        const response = await codOrdersPOST(
            postJson("/api/orders", {
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "COD",
            })
        );

        const text = await response.text();

        expect(text).not.toContain(MINTED_TOKEN);
    });

    test("an idempotent REPLAY issues no cookie (it must not clobber a working one)", async () => {
        mockCreateCheckoutOrder.mockResolvedValue(
            checkoutResult({
                guestAccessToken: null,
                duplicate: true,
            })
        );

        const response = await codOrdersPOST(
            postJson("/api/orders", {
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "COD",
            })
        );

        expect(response.status).toBe(201);
        expect(guestCookie(response)).toBeNull();
    });

    test("a logged-in buyer gets no guest access cookie", async () => {
        mockCreateCheckoutOrder.mockResolvedValue(
            checkoutResult({ guestAccessToken: null })
        );

        const response = await codOrdersPOST(
            postJson("/api/orders", {
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "COD",
            })
        );

        expect(guestCookie(response)).toBeNull();
    });
});

/* ==========================================
 * 2. BUY NOW + COD  (/api/buy-now)
 * ========================================== */

describe("POST /api/buy-now (Buy Now + COD) — guest access cookie", () => {
    test("issues the cookie with EXACTLY the persisted token", async () => {
        const response = await buyNowPOST(
            postJson("/api/buy-now", {
                productId: 1,
                variantId: 2,
                quantity: 1,
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "COD",
            })
        );

        expect(response.status).toBe(201);

        const cookie = guestCookie(response);

        expect(cookie).not.toBeNull();
        expect(cookie!.value).toBe(
            `${ORDER_ID}.${MINTED_TOKEN}`
        );
    });

    test("an idempotent REPLAY issues no cookie", async () => {
        mockCreateCheckoutOrder.mockResolvedValue(
            checkoutResult({
                guestAccessToken: null,
                duplicate: true,
            })
        );

        const response = await buyNowPOST(
            postJson("/api/buy-now", {
                productId: 1,
                variantId: 2,
                quantity: 1,
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "COD",
            })
        );

        expect(response.status).toBe(201);
        expect(guestCookie(response)).toBeNull();
    });
});

/* ==========================================
 * 3. NON-COD — iPaymu (Cart)
 * ========================================== */

describe("POST /api/payment/ipaymu (Cart) — guest access cookie", () => {
    test("issues the cookie with EXACTLY the persisted token", async () => {
        const response = await ipaymuPOST(
            postJson("/api/payment/ipaymu", {
                mode: "CART",
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "QRIS",
                paymentChannel: null,
            })
        );

        expect(response.status).toBe(200);

        const cookie = guestCookie(response);

        expect(cookie).not.toBeNull();
        expect(cookie!.value).toBe(
            `${ORDER_ID}.${MINTED_TOKEN}`
        );
    });

    test("the payment URL does not carry any access token", async () => {
        const response = await ipaymuPOST(
            postJson("/api/payment/ipaymu", {
                mode: "CART",
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "QRIS",
                paymentChannel: null,
            })
        );

        const text = await response.text();

        expect(text).not.toContain(MINTED_TOKEN);
        expect(text).toContain(
            "https://sandbox.ipaymu.test/pay/REG-4242"
        );
    });

    test("an idempotent REPLAY issues no cookie", async () => {
        mockCreateCheckoutOrder.mockResolvedValue(
            checkoutResult({
                guestAccessToken: null,
                duplicate: true,
            })
        );

        const response = await ipaymuPOST(
            postJson("/api/payment/ipaymu", {
                mode: "CART",
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "QRIS",
                paymentChannel: null,
            })
        );

        expect(response.status).toBe(200);
        expect(guestCookie(response)).toBeNull();
    });
});

/* ==========================================
 * 4. NON-COD — iPaymu (Buy Now)
 * ========================================== */

describe("POST /api/buy-now/ipaymu (Buy Now) — guest access cookie", () => {
    test("issues the cookie with EXACTLY the persisted token", async () => {
        const response = await buyNowIpaymuPOST(
            postJson("/api/buy-now/ipaymu", {
                productId: 1,
                variantId: 2,
                quantity: 1,
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "QRIS",
                paymentChannel: null,
            })
        );

        /* Buy Now iPaymu answers 201 (the Cart route answers 200). */
        expect(response.status).toBe(201);

        const cookie = guestCookie(response);

        expect(cookie).not.toBeNull();
        expect(cookie!.value).toBe(
            `${ORDER_ID}.${MINTED_TOKEN}`
        );
    });

    test("an idempotent REPLAY issues no cookie", async () => {
        mockCreateCheckoutOrder.mockResolvedValue(
            checkoutResult({
                guestAccessToken: null,
                duplicate: true,
            })
        );

        const response = await buyNowIpaymuPOST(
            postJson("/api/buy-now/ipaymu", {
                productId: 1,
                variantId: 2,
                quantity: 1,
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "QRIS",
                paymentChannel: null,
            })
        );

        expect(response.status).toBe(201);
        expect(guestCookie(response)).toBeNull();
    });
});

/* ==========================================
 * 5. Cross-order isolation of the issued cookie
 * ========================================== */

describe("Guest access cookie is bound to its own order", () => {
    test("the issued cookie is keyed by the created order's id", async () => {
        const response = await codOrdersPOST(
            postJson("/api/orders", {
                guestAddress: uniqueGuestAddress(),
                shipping,
                paymentMethod: "COD",
            })
        );

        expect(guestCookie(response, ORDER_ID)).not.toBeNull();

        /*
         * It must NOT create a cookie for any other order id — the id in
         * the cookie NAME is what resolveOrderAccess looks up.
         */
        expect(
            guestCookie(response, OTHER_ORDER_ID)
        ).toBeNull();
    });
});
