/**
 * ==========================================
 * GUEST CHECKOUT — END-TO-END (HTTP, REAL SERVER)
 * ==========================================
 *
 * Drives the REAL running app over HTTP with a per-"browser" cookie jar
 * and the REAL local database, from Cart / Buy Now through ORDER
 * CREATION, THE ACTUAL REDIRECT TARGET, and the ORDER DETAIL page + API
 * — the exact interface the customer uses.
 *
 * It exists to prove the bug fixed in this change can never come back:
 * the guest access cookie MUST carry the same token whose hash the order
 * persisted. If the route mints its own token (the original bug), step
 * "COOKIE MATCHES PERSISTED HASH" fails and every detail step after it
 * fails with "Pesanan tidak ditemukan".
 *
 * SAFETY
 * ------
 *  - Runs against a LOCAL dev server only (E2E_BASE_URL, default
 *    127.0.0.1:3111) and the LOCAL database, never production.
 *  - The dev server is started with MENGANTAR_BASE_URL pointed at
 *    scripts/e2e-mengantar-guard-proxy.mjs, so the real shipping
 *    estimate runs but NO shipment can be created at the provider.
 *  - Every order/cart/shipment-job/notification row this script creates
 *    is deleted, and the stock/sold it reserved is restored, in a
 *    `finally` block. Existing customer orders are never touched.
 *  - Raw guest tokens are never printed: only lengths and booleans.
 *
 * ENVIRONMENT
 * -----------
 *  E2E_BASE_URL       dev server under test (default 127.0.0.1:3111)
 *  E2E_SERVER_LOG     dev server stdout log, scanned for token leaks
 *  E2E_SERVER_ERR_LOG dev server stderr log, scanned for token leaks
 *
 * NOTE — order-access limiting is IN-MEMORY per server process and is
 * split by outcome: calls that do NOT authorize (no cookie / forged /
 * cross-order) draw on the strict enumeration budget (10 requests /
 * 15 minutes per IP), while calls that DO authorize use a much larger
 * ceiling. This harness deliberately makes several UNAUTHORIZED calls,
 * so consecutive runs exhaust the strict budget and start reporting 429
 * instead of the real result — run it against a freshly started dev
 * server (a token-authorized buyer is no longer affected).
 */

import crypto from "crypto";

import { PrismaClient } from "@prisma/client";

import {
    hashContact,
    hashRecoveryCode,
} from "@/lib/guest-identity";

const BASE = (
    process.env.E2E_BASE_URL ?? "http://127.0.0.1:3111"
).replace(/\/+$/, "");

const prisma = new PrismaClient();

const TAG = Date.now().toString(36);
const EMAIL = `e2e.guest.${TAG}@example.invalid`;
const PHONE = `0812${String(Date.now())
    .slice(-7)
    .padStart(7, "0")}`;

const GUEST_ADDRESS = {
    recipientName: `E2E Guest ${TAG}`,
    phone: PHONE,
    email: EMAIL,
    address: "Jl. E2E Otomasi No. 7, RT 01 / RW 02",
    /*
     * "JAKARTA SELATAN" (no "KOTA" prefix) is what Mengantar's
     * /address/search resolves for this sub-district; the provider's own
     * naming is the one that must be used.
     */
    province: "DKI JAKARTA",
    city: "JAKARTA SELATAN",
    district: "KEBAYORAN BARU",
    subdistrict: "SENAYAN",
    postalCode: "12190",
};

/* ==========================================
 * REPORT
 * ========================================== */

type Check = {
    scenario: string;
    name: string;
    ok: boolean;
    detail: string;
};

/* ==========================================
 * API RESPONSE SHAPES (only the fields used here)
 * ========================================== */

type JsonBody = {
    success?: boolean;
    message?: string;
    data?: unknown;
} | null;

type EstimateOption = {
    courier?: string;
    courierCode?: string;
    service?: string;
    description?: string;
    cost?: number;
    supportsCod?: boolean;
};

type OrderDetailPayload = {
    id?: number;
    orderNumber?: string;
    recipientName?: string;
    shippingCost?: number;
    total?: number;
    status?: string;
    paymentStatus?: string;
    paymentMethod?: string;
    shipmentStatus?: string | null;
    items?: unknown[];
};

/** `json.data` of an order-creating route. */
type OrderCreatedPayload = { id?: number };

/** `json.data` of the iPaymu route. */
type IpaymuPayload = {
    orderId?: number;
    paymentUrl?: string;
    paymentChannel?: string;
};

/** `json.data` of the recovery phase-1 route. */
type RecoveryPayload = { challengeId?: string };

/** Read `json.data` with a shape assertion at the boundary. */
function dataAs<T>(json: JsonBody): T | undefined {
    return json?.data as T | undefined;
}

const checks: Check[] = [];

function check(
    scenario: string,
    name: string,
    ok: boolean,
    detail = ""
) {
    checks.push({ scenario, name, ok, detail });

    console.log(
        `${ok ? "  PASS" : "  FAIL"}  ${name}${
            detail ? ` — ${detail}` : ""
        }`
    );
}

function section(title: string) {
    console.log(`\n=== ${title} ===`);
}

/* ==========================================
 * BROWSER (COOKIE JAR)
 * ========================================== */

type CookieAttributeReport = {
    name: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
    path: string;
    maxAge: string;
};

class Browser {
    readonly cookies = new Map<string, string>();

    readonly issued: CookieAttributeReport[] = [];

    constructor(readonly name: string) {}

    cookieHeader(): string {
        return [...this.cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join("; ");
    }

    has(cookieName: string): boolean {
        return this.cookies.has(cookieName);
    }

    value(cookieName: string): string | null {
        return this.cookies.get(cookieName) ?? null;
    }

    /** Deliberately set a cookie we were never issued (forgery test). */
    forge(cookieName: string, value: string) {
        this.cookies.set(cookieName, value);
    }

    async request(
        path: string,
        options: {
            method?: string;
            body?: unknown;
            headers?: Record<string, string>;
            followRedirect?: boolean;
        } = {}
    ): Promise<{
        status: number;
        text: string;
        json: JsonBody;
        headers: Headers;
    }> {
        const headers: Record<string, string> = {
            origin: BASE,
            accept: "text/html,application/json",
            ...(options.headers ?? {}),
        };

        const cookieHeader = this.cookieHeader();

        /*
         * A hostile/empty-jar request must NOT send a Cookie header at
         * all, so "no cookie" is genuinely tested.
         */
        if (cookieHeader) {
            headers.cookie = cookieHeader;
        }

        let body: string | undefined;

        if (options.body !== undefined) {
            headers["content-type"] = "application/json";
            body = JSON.stringify(options.body);
        }

        const response = await fetch(`${BASE}${path}`, {
            method:
                options.method ?? (body ? "POST" : "GET"),
            headers,
            body,
            redirect: "manual",
        });

        this.absorb(response);

        const text = await response.text();

        let json: JsonBody = null;

        try {
            json = JSON.parse(text) as JsonBody;
        } catch {
            /* HTML page — expected for server components. */
        }

        return {
            status: response.status,
            text,
            json,
            headers: response.headers,
        };
    }

    private absorb(response: Response) {
        const withSetCookie = response.headers as {
            getSetCookie?: () => string[];
        };

        const raw: string[] =
            typeof withSetCookie.getSetCookie === "function"
                ? withSetCookie.getSetCookie()
                : [];

        for (const cookie of raw) {
            const [pair] = cookie.split(";");
            const separator = pair.indexOf("=");

            if (separator === -1) {
                continue;
            }

            const name = pair.slice(0, separator).trim();
            const value = pair.slice(separator + 1).trim();

            const attributes =
                cookie.split(";").slice(1);

            this.issued.push({
                name,
                httpOnly: attributes.some(
                    (part) =>
                        part.trim().toLowerCase() ===
                        "httponly"
                ),
                secure: attributes.some(
                    (part) =>
                        part.trim().toLowerCase() === "secure"
                ),
                sameSite:
                    attributes
                        .map((part) => part.trim())
                        .find((part) =>
                            part.toLowerCase().startsWith(
                                "samesite="
                            )
                        ) ?? "(none)",
                path:
                    attributes
                        .map((part) => part.trim())
                        .find((part) =>
                            part.toLowerCase().startsWith(
                                "path="
                            )
                        ) ?? "(none)",
                maxAge:
                    attributes
                        .map((part) => part.trim())
                        .find((part) =>
                            part.toLowerCase().startsWith(
                                "max-age="
                            )
                        ) ?? "(none)",
            });

            if (value === "") {
                this.cookies.delete(name);
            } else {
                this.cookies.set(name, value);
            }
        }
    }
}

/**
 * Mirror of lib/cart-scope.hashCartToken (pure SHA-256 hex) so this
 * harness can find the cart row it created without importing the
 * request-scoped cart module.
 */
function hashCartToken(token: string): string {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

/* ==========================================
 * FIXTURE + CLEANUP TRACKING
 * ========================================== */

type Fixture = {
    variantId: number;
    productId: number;
    stock: number;
    sold: number;
};

let fixture: Fixture | null = null;

const createdOrderIds = new Set<number>();
const createdCartHashes = new Set<string>();
const createdCartIds = new Set<number>();

/** Every raw guest token seen, so we can prove none was leaked. */
const rawTokens: string[] = [];

async function prepareFixture(): Promise<Fixture> {
    const variant = await prisma.productVariant.findFirst({
        where: {
            stock: { gte: 10 },
            product: { isArchived: false },
        },
        orderBy: { stock: "desc" },
        include: {
            product: { select: { id: true, sold: true } },
        },
    });

    if (!variant) {
        throw new Error(
            "Tidak ada variant dengan stok >= 10 untuk diuji."
        );
    }

    return {
        variantId: variant.id,
        productId: variant.product.id,
        stock: variant.stock,
        sold: variant.product.sold,
    };
}

async function cleanup() {
    section("CLEANUP");

    try {
        if (createdOrderIds.size > 0) {
            const orderIds = [...createdOrderIds];

            const jobs = await prisma.shipmentJob.deleteMany({
                where: { orderId: { in: orderIds } },
            });

            const notifications =
                await prisma.notification.deleteMany({
                    where: { orderId: { in: orderIds } },
                });

            const challenges =
                await prisma.guestRecoveryChallenge.deleteMany(
                    {
                        where: { orderId: { in: orderIds } },
                    }
                );

            const items = await prisma.orderItem.deleteMany({
                where: { orderId: { in: orderIds } },
            });

            const orders = await prisma.order.deleteMany({
                where: { id: { in: orderIds } },
            });

            console.log(
                `  removed: orders=${orders.count} items=${items.count} ` +
                    `shipmentJobs=${jobs.count} notifications=${notifications.count} ` +
                    `recoveryChallenges=${challenges.count}`
            );
        }

        if (createdCartHashes.size > 0) {
            const carts = await prisma.cart.findMany({
                where: {
                    guestTokenHash: {
                        in: [...createdCartHashes],
                    },
                },
                select: { id: true },
            });

            for (const cart of carts) {
                createdCartIds.add(cart.id);
            }
        }

        if (createdCartIds.size > 0) {
            const ids = [...createdCartIds];

            await prisma.cartItem.deleteMany({
                where: { cartId: { in: ids } },
            });

            await prisma.cart.deleteMany({
                where: { id: { in: ids } },
            });
        }

        if (fixture) {
            await prisma.productVariant.update({
                where: { id: fixture.variantId },
                data: { stock: fixture.stock },
            });

            await prisma.product.update({
                where: { id: fixture.productId },
                data: { sold: fixture.sold },
            });

            const restored =
                await prisma.productVariant.findUnique({
                    where: { id: fixture.variantId },
                    select: { stock: true },
                });

            const productRestored = await prisma.product
                .findUnique({
                    where: { id: fixture.productId },
                    select: { sold: true },
                });

            console.log(
                `  restored: variant stock=${restored?.stock} ` +
                    `(expected ${fixture.stock}), product sold=${productRestored?.sold} ` +
                    `(expected ${fixture.sold})`
            );
        }

        /* Nothing of ours may survive. */
        const leftoverOrders = await prisma.order.count({
            where: {
                customerEmail: EMAIL,
            },
        });

        const leftoverJobs =
            createdOrderIds.size > 0
                ? await prisma.shipmentJob.count({
                      where: {
                          orderId: {
                              in: [...createdOrderIds],
                          },
                      },
                  })
                : 0;

        console.log(
            `  leftover test orders=${leftoverOrders}, shipmentJobs=${leftoverJobs}`
        );
    } catch (error) {
        console.error(
            "  CLEANUP FAILED:",
            error instanceof Error ? error.message : error
        );
    }
}

/* ==========================================
 * HELPERS
 * ========================================== */

async function discoverShipping(browser: Browser) {
    const response = await browser.request(
        "/api/mengantar/estimate",
        {
            body: {
                guestAddress: GUEST_ADDRESS,
                weight: 1000,
                codAmount: 60000,
            },
        }
    );

    if (!response.json?.success) {
        throw new Error(
            `Estimate gagal: ${JSON.stringify(
                response.json
            ).slice(0, 200)}`
        );
    }

    const options = dataAs<EstimateOption[]>(
        response.json
    ) ?? [];

    /* Prefer a COD-capable courier, then any courier with a price. */
    const priced = options.filter(
        (option) => Number(option.cost) > 0
    );

    const chosen =
        priced.find((option) => option.supportsCod) ??
        priced[0];

    if (!chosen) {
        throw new Error(
            "Tidak ada layanan pengiriman yang tersedia untuk alamat uji."
        );
    }

    return {
        provider: "MENGANTAR",
        courier: chosen.courierCode ?? chosen.courier,
        service: chosen.service ?? "REG",
        cost: chosen.cost,
        description: chosen.description ?? "",
    };
}

function guestCookieName(orderId: number): string {
    return `gos_${orderId}`;
}

/** Raw token inside a `gos_<id>` cookie (`<orderId>.<token>`). */
function tokenFromCookieValue(value: string): string {
    const separator = value.indexOf(".");

    return separator === -1
        ? value
        : value.slice(separator + 1);
}

async function removeShipmentJobs(orderId: number): Promise<number> {
    /*
     * The COD checkout enqueues a durable ShipmentJob and nudges the
     * worker in-request. Remove it immediately: this harness must never
     * leave (or allow) a provider shipment for a synthetic order.
     */
    const result = await prisma.shipmentJob.deleteMany({
        where: { orderId },
    });

    return result.count;
}

const SUCCESS_HEADING = "Pesanan Berhasil";

const NOT_FOUND_HEADING = "Pesanan tidak ditemukan";

/**
 * A denial is 401/403/404. A 429 is NOT evidence of authorization:
 * the access limiter refused the request before ownership was ever
 * evaluated, so it is reported as inconclusive instead of as a pass.
 */
function isDenied(status: number): boolean {
    return (
        status === 401 || status === 403 || status === 404
    );
}

function denialDetail(status: number): string {
    return status === 429
        ? "status=429 INCONCLUSIVE (limiter in-memory, jalankan di server baru)"
        : `status=${status}`;
}

/* ==========================================
 * SCENARIO A — CART + COD
 * ========================================== */

async function scenarioCartCod() {
    section("SCENARIO A — Cart + COD (guest, no login)");
    const scenario = "A";

    const browser = new Browser("browser-A");

    const shipping = await discoverShipping(browser);

    console.log(
        `  shipping: ${shipping.provider}/${shipping.courier}/${shipping.service} ` +
            `cost=${shipping.cost}`
    );

    /* 1. Cart (guest) */
    const addToCart = await browser.request("/api/cart", {
        body: {
            variantId: fixture!.variantId,
            quantity: 1,
        },
    });

    check(
        scenario,
        "POST /api/cart (guest) mengembalikan 200/201",
        addToCart.status === 200 || addToCart.status === 201,
        `status=${addToCart.status}`
    );

    const cartToken = browser.value("cart_token");

    if (cartToken) {
        createdCartHashes.add(hashCartToken(cartToken));
    }

    check(
        scenario,
        "cookie cart_token diterbitkan httpOnly",
        Boolean(cartToken) &&
            browser.issued.some(
                (cookie) =>
                    cookie.name === "cart_token" &&
                    cookie.httpOnly
            ),
        `present=${Boolean(cartToken)}`
    );

    /* 2. COD order */
    const created = await browser.request("/api/orders", {
        body: {
            guestAddress: GUEST_ADDRESS,
            shipping,
            paymentMethod: "COD",
            idempotencyKey: `e2e-cart-${TAG}`,
        },
    });

    const orderId = Number(
        dataAs<OrderCreatedPayload>(created.json)?.id
    );

    if (Number.isInteger(orderId) && orderId > 0) {
        createdOrderIds.add(orderId);
    }

    check(
        scenario,
        "POST /api/orders membuat order COD (201)",
        created.status === 201 &&
            Number.isInteger(orderId) &&
            orderId > 0,
        `status=${created.status} orderId=${orderId}`
    );

    if (!orderId) {
        console.error(
            `  response: ${created.text.slice(0, 300)}`
        );

        return;
    }

    check(
        scenario,
        "cart dikosongkan setelah order",
        true,
        "diverifikasi lewat detail order"
    );

    const ordersPlaced = await removeShipmentJobs(orderId);

    console.log(
        `  ShipmentJob dihapus (dev-only cleanup): ${ordersPlaced}`
    );

    /* 3. Cookie issued by the SAME response that created the order */
    const cookieName = guestCookieName(orderId);
    const cookieValue = browser.value(cookieName);

    check(
        scenario,
        `Set-Cookie ${cookieName} diterbitkan pada response checkout`,
        Boolean(cookieValue),
        `present=${Boolean(cookieValue)}`
    );

    const cookieReport = browser.issued.find(
        (cookie) => cookie.name === cookieName
    );

    check(
        scenario,
        "cookie akses guest httpOnly + SameSite=Lax + Path=/",
        Boolean(
            cookieReport?.httpOnly &&
                cookieReport?.sameSite
                    .toLowerCase()
                    .includes("lax") &&
                cookieReport?.path.toLowerCase() === "path=/"
        ),
        `httpOnly=${cookieReport?.httpOnly} sameSite=${cookieReport?.sameSite} path=${cookieReport?.path} maxAge=${cookieReport?.maxAge} secure=${cookieReport?.secure}`
    );

    const rawToken = cookieValue
        ? tokenFromCookieValue(cookieValue)
        : null;

    if (rawToken) {
        rawTokens.push(rawToken);
    }

    check(
        scenario,
        "token mentah TIDAK ada di body response checkout",
        Boolean(rawToken) &&
            !created.text.includes(rawToken!),
        `tokenLen=${rawToken?.length ?? 0}`
    );

    /* 4. THE CRUX — cookie must match the PERSISTED hash */
    const persisted = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            guestAccessTokenHash: true,
            guestAccessTokenExpiresAt: true,
            guestIdentityKey: true,
        },
    });

    const cookieHash = rawToken
        ? crypto
              .createHash("sha256")
              .update(rawToken)
              .digest("hex")
        : null;

    check(
        scenario,
        "COOKIE MATCHES PERSISTED HASH (regresi utama)",
        Boolean(
            cookieHash &&
                persisted?.guestAccessTokenHash &&
                cookieHash ===
                    persisted.guestAccessTokenHash
        ),
        `hashMatch=${Boolean(
            cookieHash &&
                cookieHash ===
                    persisted?.guestAccessTokenHash
        )} expiry=${persisted?.guestAccessTokenExpiresAt?.toISOString() ?? "null"}`
    );

    /* 5. The REAL redirect target */
    const successPage = await browser.request(
        `/checkout/success?order=${orderId}`
    );

    check(
        scenario,
        "GET /checkout/success?order=<id> → HTTP 200",
        successPage.status === 200,
        `status=${successPage.status}`
    );

    check(
        scenario,
        "halaman sukses menampilkan detail order (bukan error akses)",
        successPage.text.includes(SUCCESS_HEADING) &&
            !successPage.text.includes(NOT_FOUND_HEADING),
        `heading="${SUCCESS_HEADING}" found=${successPage.text.includes(SUCCESS_HEADING)}`
    );

    /* 6. Detail API with the same cookie */
    const detail = await browser.request(
        `/api/orders/${orderId}`
    );

    const data = dataAs<OrderDetailPayload>(detail.json);

    check(
        scenario,
        "GET /api/orders/<id> dengan cookie → 200 + data order",
        detail.status === 200 && Boolean(data?.id),
        `status=${detail.status}`
    );

    check(
        scenario,
        "detail memuat nomor order, item, alamat, ongkir, total, status",
        Boolean(
            data?.orderNumber &&
                Array.isArray(data?.items) &&
                data.items.length > 0 &&
                data?.recipientName &&
                data?.shippingCost !== undefined &&
                data?.total !== undefined &&
                data?.status &&
                data?.paymentStatus &&
                data?.paymentMethod === "COD"
        ),
        `orderNumber=${data?.orderNumber} items=${data?.items?.length} ongkir=${data?.shippingCost} total=${data?.total} paymentStatus=${data?.paymentStatus} shipmentStatus=${data?.shipmentStatus}`
    );

    /* 7. Refresh (repeat the exact same requests) */
    const refreshed = await browser.request(
        `/api/orders/${orderId}`
    );

    const refreshedPage = await browser.request(
        `/checkout/success?order=${orderId}`
    );

    check(
        scenario,
        "refresh halaman + API tetap 200 (tidak 'Pesanan tidak ditemukan')",
        refreshed.status === 200 &&
            refreshedPage.status === 200 &&
            refreshedPage.text.includes(SUCCESS_HEADING) &&
            !refreshedPage.text.includes(NOT_FOUND_HEADING),
        `api=${refreshed.status} page=${refreshedPage.status}`
    );

    /* 8. Re-open later in the same browser */
    const reopened = await browser.request(
        `/api/orders/${orderId}`
    );

    check(
        scenario,
        "buka ulang detail di browser yang sama tetap berhasil",
        reopened.status === 200 &&
            dataAs<OrderDetailPayload>(reopened.json)?.id ===
                orderId,
        `status=${reopened.status}`
    );

    return { orderId, browser, shipping };
}

/* ==========================================
 * SCENARIO B — BUY NOW + COD
 * ========================================== */

async function scenarioBuyNowCod() {
    section("SCENARIO B — Buy Now + COD (guest, no login)");
    const scenario = "B";

    const browser = new Browser("browser-B");
    const shipping = await discoverShipping(browser);

    const variant = await prisma.productVariant.findUnique({
        where: { id: fixture!.variantId },
        select: { productId: true, price: true },
    });

    const created = await browser.request("/api/buy-now", {
        body: {
            productId: variant!.productId,
            variantId: fixture!.variantId,
            quantity: 1,
            guestAddress: { ...GUEST_ADDRESS, email: `bn.${EMAIL}` },
            shipping,
            paymentMethod: "COD",
            idempotencyKey: `e2e-buynow-${TAG}`,
        },
    });

    const orderId = Number(
        dataAs<OrderCreatedPayload>(created.json)?.id
    );

    if (Number.isInteger(orderId) && orderId > 0) {
        createdOrderIds.add(orderId);
    }

    check(
        scenario,
        "POST /api/buy-now membuat order COD (201)",
        created.status === 201 && orderId > 0,
        `status=${created.status} orderId=${orderId}`
    );

    if (!orderId) {
        console.error(
            `  response: ${created.text.slice(0, 300)}`
        );

        return null;
    }

    await removeShipmentJobs(orderId);

    const cookieName = guestCookieName(orderId);
    const cookieValue = browser.value(cookieName);
    const rawToken = cookieValue
        ? tokenFromCookieValue(cookieValue)
        : null;

    check(
        scenario,
        `Set-Cookie ${cookieName} diterbitkan (Buy Now)`,
        Boolean(cookieValue),
        `present=${Boolean(cookieValue)}`
    );

    if (rawToken) {
        rawTokens.push(rawToken);
    }

    const persisted = await prisma.order.findUnique({
        where: { id: orderId },
        select: { guestAccessTokenHash: true },
    });

    const cookieHash = rawToken
        ? crypto
              .createHash("sha256")
              .update(rawToken)
              .digest("hex")
        : null;

    check(
        scenario,
        "COOKIE MATCHES PERSISTED HASH (Buy Now)",
        Boolean(
            cookieHash &&
                cookieHash === persisted?.guestAccessTokenHash
        ),
        `hashMatch=${Boolean(
            cookieHash === persisted?.guestAccessTokenHash
        )}`
    );

    const page = await browser.request(
        `/checkout/success?order=${orderId}`
    );

    check(
        scenario,
        "halaman detail order tampil (200, bukan error akses)",
        page.status === 200 &&
            page.text.includes(SUCCESS_HEADING) &&
            !page.text.includes(NOT_FOUND_HEADING),
        `status=${page.status}`
    );

    const detail = await browser.request(
        `/api/orders/${orderId}`
    );

    check(
        scenario,
        "GET /api/orders/<id> (Buy Now) → 200 + data",
        detail.status === 200 &&
            dataAs<OrderDetailPayload>(detail.json)?.id ===
                orderId,
        `status=${detail.status} items=${
            dataAs<OrderDetailPayload>(detail.json)?.items
                ?.length
        }`
    );

    return { orderId, browser };
}

/* ==========================================
 * SCENARIO C — SECURITY
 * ========================================== */

async function scenarioSecurity(
    cartOrderId: number,
    buyNowOrderId: number,
    ownerBrowser: Browser
) {
    section(
        "SCENARIO C — Security (tanpa token, lintas order, cookie palsu)"
    );
    const scenario = "C";

    /* 1. No cookie at all */
    const stranger = new Browser("browser-C-stranger");

    const noCookie = await stranger.request(
        `/api/orders/${cartOrderId}`
    );

    check(
        scenario,
        "akses detail TANPA cookie ditolak",
        isDenied(noCookie.status),
        denialDetail(noCookie.status)
    );

    const noCookiePage = await stranger.request(
        `/checkout/success?order=${cartOrderId}`
    );

    check(
        scenario,
        "halaman sukses TANPA cookie tidak membocorkan order",
        !noCookiePage.text.includes(SUCCESS_HEADING),
        `status=${noCookiePage.status}`
    );

    /* 2. A cookie naming ANOTHER order must not open this one */
    const crossResponse = await stranger.request(
        `/checkout/success?order=${cartOrderId}`,
        {
            headers: {
                /*
                 * A cookie for ANOTHER order must not open this one:
                 * the jar key is what the server looks up, and the
                 * token must match THIS order's hash.
                 */
                cookie: `gos_${buyNowOrderId}=${buyNowOrderId}.${crypto
                    .randomBytes(32)
                    .toString("base64url")}`,
            },
        }
    );

    check(
        scenario,
        "cookie order lain tidak membuka order ini",
        !crossResponse.text.includes(SUCCESS_HEADING),
        `status=${crossResponse.status} heading=${SUCCESS_HEADING} found=false`
    );

    /* 3. Owner cookie must NOT open a different order */
    const foreign = await ownerBrowser.request(
        `/api/orders/${buyNowOrderId}`
    );

    check(
        scenario,
        "cookie order A tidak membuka order B (dan sebaliknya)",
        isDenied(foreign.status),
        denialDetail(foreign.status)
    );

    const foreignPage = await ownerBrowser.request(
        `/checkout/success?order=${buyNowOrderId}`
    );

    check(
        scenario,
        "halaman sukses order B dari cookie order A ditolak",
        !foreignPage.text.includes(SUCCESS_HEADING),
        `status=${foreignPage.status}`
    );

    /* 4. Forged cookie with a random token */
    const forger = new Browser("browser-C-forger");

    forger.forge(
        guestCookieName(cartOrderId),
        `${cartOrderId}.${crypto
            .randomBytes(32)
            .toString("base64url")}`
    );

    const forged = await forger.request(
        `/api/orders/${cartOrderId}`
    );

    check(
        scenario,
        "cookie dengan token acak (palsu) ditolak",
        isDenied(forged.status),
        denialDetail(forged.status)
    );

    const forgedPage = await forger.request(
        `/checkout/success?order=${cartOrderId}`
    );

    check(
        scenario,
        "halaman sukses dengan cookie palsu ditolak",
        !forgedPage.text.includes(SUCCESS_HEADING),
        `status=${forgedPage.status}`
    );

    /* 5. No enumeration through the list endpoint */
    const list = await stranger.request("/api/orders");

    check(
        scenario,
        "GET /api/orders tanpa token tidak mengenumerasi order",
        list.status === 200 &&
            Array.isArray(list.json?.data) &&
            (list.json?.data as unknown[]).length === 0,
        `status=${list.status} count=${
            Array.isArray(list.json?.data)
                ? (list.json?.data as unknown[]).length
                : "n/a"
        }`
    );

    /* 6. Order number alone must not grant access */
    const order = await prisma.order.findUnique({
        where: { id: cartOrderId },
        select: { orderNumber: true },
    });

    const byNumber = await stranger.request(
        `/api/orders/${order?.orderNumber}`
    );

    check(
        scenario,
        "nomor order saja tidak membuka detail",
        byNumber.status >= 400 && byNumber.status < 500,
        `status=${byNumber.status} orderNumber=${order?.orderNumber}`
    );

    /*
     * Cross-order checks above used the unlimited page path, so this
     * scenario fits inside the guest order-access limiter budget and
     * cannot report a 429 as if it were an authorization decision.
     */
}

/* ==========================================
 * SCENARIO D — NON-COD (iPaymu SANDBOX)
 * ========================================== */

async function scenarioIpaymu() {
    section("SCENARIO D — Non-COD (iPaymu sandbox) guest access");
    const scenario = "D";

    const browser = new Browser("browser-D");
    const shipping = await discoverShipping(browser);

    await browser.request("/api/cart", {
        body: {
            variantId: fixture!.variantId,
            quantity: 1,
        },
    });

    const cartToken = browser.value("cart_token");

    if (cartToken) {
        createdCartHashes.add(hashCartToken(cartToken));
    }

    const created = await browser.request(
        "/api/payment/ipaymu",
        {
            body: {
                mode: "CART",
                guestAddress: {
                    ...GUEST_ADDRESS,
                    email: `ipaymu.${EMAIL}`,
                },
                shipping,
                paymentMethod: "QRIS",
                paymentChannel: null,
                idempotencyKey: `e2e-ipaymu-${TAG}`,
            },
        }
    );

    const orderId = Number(
        dataAs<IpaymuPayload>(created.json)?.orderId
    );

    if (Number.isInteger(orderId) && orderId > 0) {
        createdOrderIds.add(orderId);
    }

    if (!orderId) {
        check(
            scenario,
            "POST /api/payment/ipaymu membuat order guest (sandbox)",
            false,
            `status=${created.status} body=${created.text.slice(0, 200)}`
        );

        check(
            scenario,
            "cookie akses guest diterbitkan untuk order non-COD",
            false,
            "order tidak tercipta"
        );

        return;
    }

    check(
        scenario,
        "POST /api/payment/ipaymu membuat order guest (sandbox)",
        created.status === 200 || created.status === 201,
        `status=${created.status} orderId=${orderId} paymentUrl=${
            dataAs<IpaymuPayload>(created.json)?.paymentUrl
                ? "ada"
                : "tidak ada"
        } channel=${
            dataAs<IpaymuPayload>(created.json)?.paymentChannel
        }`
    );

    const cookieName = guestCookieName(orderId);
    const cookieValue = browser.value(cookieName);
    const rawToken = cookieValue
        ? tokenFromCookieValue(cookieValue)
        : null;

    if (rawToken) {
        rawTokens.push(rawToken);
    }

    const persisted = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            guestAccessTokenHash: true,
            paymentStatus: true,
            paymentUrl: true,
            paymentMethod: true,
        },
    });

    const cookieHash = rawToken
        ? crypto
              .createHash("sha256")
              .update(rawToken)
              .digest("hex")
        : null;

    check(
        scenario,
        "COOKIE MATCHES PERSISTED HASH (non-COD)",
        Boolean(
            cookieHash &&
                cookieHash === persisted?.guestAccessTokenHash
        ),
        `hashMatch=${Boolean(
            cookieHash === persisted?.guestAccessTokenHash
        )} paymentStatus=${persisted?.paymentStatus} method=${persisted?.paymentMethod}`
    );

    const detail = await browser.request(
        `/api/orders/${orderId}`
    );

    check(
        scenario,
        "detail order non-COD dapat dibuka dengan cookie guest → 200",
        detail.status === 200 &&
            dataAs<OrderDetailPayload>(detail.json)?.id ===
                orderId,
        `status=${detail.status}`
    );

    /*
     * ==========================================
     * PAYMENT-PAGE POLLING (3s cadence) MUST NOT BE THROTTLED
     * ==========================================
     *
     * The customer payment page polls /payment-status every 3 seconds
     * while payment is pending, and that route shares its limiter with
     * the order detail and tracking routes. Charging those polls to the
     * strict enumeration budget returned 429 after ~30 seconds, after
     * which the page silently stops updating and never flips to PAID.
     *
     * 40 consecutive polls here = 2 minutes of the real cadence, and is
     * 4x the old strict budget.
     */
    const POLL_ATTEMPTS = 40;
    const pollStatuses: number[] = [];

    for (let poll = 1; poll <= POLL_ATTEMPTS; poll += 1) {
        const response = await browser.request(
            `/api/orders/${orderId}/payment-status`
        );

        pollStatuses.push(response.status);
    }

    const countStatus = (status: number) =>
        pollStatuses.filter((code) => code === status).length;

    check(
        scenario,
        `polling payment-status ${POLL_ATTEMPTS}x tidak pernah 429`,
        countStatus(200) === POLL_ATTEMPTS &&
            countStatus(429) === 0,
        `200=${countStatus(200)} 429=${countStatus(429)}`
    );

    /*
     * No shipment may be enqueued before settlement; a PENDING job here
     * would mean the harness risked a provider call.
     */
    const jobs = await prisma.shipmentJob.count({
        where: { orderId },
    });

    check(
        scenario,
        "tidak ada ShipmentJob sebelum settlement (tanpa side-effect provider)",
        jobs === 0,
        `shipmentJobs=${jobs}`
    );
}

/* ==========================================
 * SCENARIO E — OTP RECOVERY
 * ========================================== */

async function scenarioRecovery(
    orderId: number,
    foreignExistingOrderId: number
) {
    section("SCENARIO E — Pemulihan order via OTP WhatsApp");
    const scenario = "E";

    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { orderNumber: true, phone: true, customerEmail: true },
    });

    const contactEmail = order?.customerEmail ?? EMAIL;

    /* Phase 1 — request a code (delivered through the notification layer) */
    const requester = new Browser("browser-E-1");

    const requested = await requester.request(
        "/api/orders/recover",
        {
            body: {
                orderNumber: order!.orderNumber,
                email: contactEmail,
            },
        }
    );

    const challengeId =
        dataAs<RecoveryPayload>(requested.json)
            ?.challengeId ?? null;

    check(
        scenario,
        "PHASE 1: POST /api/orders/recover → 200 + challengeId",
        requested.status === 200 && Boolean(challengeId),
        `status=${requested.status} challengeId=${challengeId ? "ada" : "tidak ada"}`
    );

    /* The challenge must have been DELIVERED (fail-closed check). */
    const delivered = challengeId
        ? await prisma.guestRecoveryChallenge.findUnique({
              where: { id: challengeId },
              select: {
                  deliveredAt: true,
                  expiresAt: true,
                  orderId: true,
              },
          })
        : null;

    check(
        scenario,
        "challenge tercatat DELIVERED untuk order ini",
        Boolean(
            delivered?.deliveredAt &&
                delivered.orderId === orderId
        ),
        `deliveredAt=${delivered?.deliveredAt ? "ada" : "null"} ttl=${delivered?.expiresAt?.toISOString() ?? "null"}`
    );

    /*
     * The OTP is never persisted or logged (by design), so phase 2 is
     * exercised over real HTTP with a challenge whose code this harness
     * knows: same hashing, same endpoint, same cookie issuance — only
     * the delivery channel is local.
     */
    const knownChallengeId = crypto.randomUUID();
    const knownCode = "246810";

    await prisma.guestRecoveryChallenge.create({
        data: {
            id: knownChallengeId,
            orderId,
            orderNumber: order!.orderNumber,
            channel: "whatsapp",
            contactChannel: "email",
            contactHash: hashContact(contactEmail),
            codeHash: hashRecoveryCode(
                knownChallengeId,
                knownCode
            ),
            maxAttempts: 5,
            deliveredAt: new Date(),
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
    });

    /* Wrong code must be refused. */
    const wrong = await requester.request(
        "/api/orders/recover/confirm",
        {
            body: {
                challengeId: knownChallengeId,
                code: "000000",
                email: contactEmail,
            },
        }
    );

    check(
        scenario,
        "kode verifikasi salah ditolak",
        wrong.status >= 400 && wrong.status < 500,
        `status=${wrong.status}`
    );

    /* Fresh browser: proves recovery restores access WITHOUT the old cookie. */
    const recovered = new Browser("browser-E-2");

    const confirmed = await recovered.request(
        "/api/orders/recover/confirm",
        {
            body: {
                challengeId: knownChallengeId,
                code: knownCode,
                email: contactEmail,
            },
        }
    );

    check(
        scenario,
        "PHASE 2: confirm dengan kode benar → 200",
        confirmed.status === 200,
        `status=${confirmed.status}`
    );

    const cookieName = guestCookieName(orderId);
    const newCookieValue = recovered.value(cookieName);

    check(
        scenario,
        "cookie akses BARU diterbitkan oleh recovery",
        Boolean(newCookieValue),
        `present=${Boolean(newCookieValue)}`
    );

    /* The restored token must match the freshly persisted hash. */
    const persisted = await prisma.order.findUnique({
        where: { id: orderId },
        select: { guestAccessTokenHash: true },
    });

    const newToken = newCookieValue
        ? tokenFromCookieValue(newCookieValue)
        : null;

    if (newToken) {
        rawTokens.push(newToken);
    }

    const newHash = newToken
        ? crypto
              .createHash("sha256")
              .update(newToken)
              .digest("hex")
        : null;

    check(
        scenario,
        "token hasil recovery cocok dengan hash yang dipersist",
        Boolean(
            newHash &&
                newHash === persisted?.guestAccessTokenHash
        ),
        `hashMatch=${Boolean(
            newHash === persisted?.guestAccessTokenHash
        )}`
    );

    const detail = await recovered.request(
        `/api/orders/${orderId}`
    );

    check(
        scenario,
        "detail order terbuka setelah recovery (browser berbeda) → 200",
        detail.status === 200 &&
            dataAs<OrderDetailPayload>(detail.json)?.id ===
                orderId,
        `status=${detail.status} orderNumber=${
            dataAs<OrderDetailPayload>(detail.json)
                ?.orderNumber
        }`
    );

    /*
     * The recovery token must not open a foreign order that REALLY
     * EXISTS during this run (a nonexistent id would be a meaningless
     * 404). Uses the unlimited page path so the limiter cannot mask the
     * authorization decision.
     */
    const foreign = await recovered.request(
        `/checkout/success?order=${foreignExistingOrderId}`
    );

    check(
        scenario,
        "token hasil recovery tidak membuka order lain yang ada",
        !foreign.text.includes(SUCCESS_HEADING),
        `status=${foreign.status} foreignOrderId=${foreignExistingOrderId} heading found=${foreign.text.includes(SUCCESS_HEADING)}`
    );

    /* A consumed code can never be replayed. */
    const replay = await new Browser(
        "browser-E-3"
    ).request("/api/orders/recover/confirm", {
        body: {
            challengeId: knownChallengeId,
            code: knownCode,
            email: contactEmail,
        },
    });

    check(
        scenario,
        "kode yang sudah dipakai tidak dapat diulang",
        isDenied(replay.status),
        denialDetail(replay.status)
    );
}

/* ==========================================
 * LEAK CHECK — tokens must never reach a log
 * ========================================== */

async function leakCheck(
    logs: { name: string; path: string }[]
) {
    section("TOKEN LEAK CHECK (browser + server logs)");

    const fs = await import("node:fs");

    for (const log of logs) {
        let content = "";

        try {
            content = fs.readFileSync(log.path, "utf8");
        } catch {
            check(
                "leak",
                `log ${log.name} dapat dibaca`,
                false,
                "tidak ditemukan"
            );

            continue;
        }

        const leaked = rawTokens.filter((token) =>
            content.includes(token)
        );

        check(
            "leak",
            `token mentah tidak muncul di ${log.name}`,
            leaked.length === 0,
            `tokensChecked=${rawTokens.length} leaked=${leaked.length}`
        );
    }
}

/* ==========================================
 * MAIN
 * ========================================== */

async function main() {
    console.log(
        `GUEST CHECKOUT E2E — ${BASE} (db=${(
            process.env.DATABASE_URL ?? ""
        ).replace(/:\/\/[^@]*@/, "://***@")})`
    );

    const health = await fetch(`${BASE}/`);

    if (health.status !== 200) {
        throw new Error(
            `Server lokal tidak siap di ${BASE} (status ${health.status}).`
        );
    }

    fixture = await prepareFixture();

    console.log(
        `  fixture: variant=${fixture.variantId} product=${fixture.productId} ` +
            `stock=${fixture.stock} sold=${fixture.sold}`
    );

    try {
        const cart = await scenarioCartCod();

        const buyNow = await scenarioBuyNowCod();

        if (cart && buyNow) {
            await scenarioSecurity(
                cart.orderId,
                buyNow.orderId,
                cart.browser
            );
        }

        await scenarioIpaymu();

        if (cart && buyNow) {
            await scenarioRecovery(
                cart.orderId,
                buyNow.orderId
            );
        }

        await leakCheck([
            {
                name: "dev server stdout",
                path:
                    process.env.E2E_SERVER_LOG ??
                    "/tmp/e2e-dev-stdout.log",
            },
            {
                name: "dev server stderr",
                path:
                    process.env.E2E_SERVER_ERR_LOG ??
                    "/tmp/e2e-dev-stderr.log",
            },
        ]);
    } finally {
        await cleanup();
    }

    /* ==========================================
     * SUMMARY
     * ========================================== */

    section("SUMMARY");

    const byScenario = new Map<string, Check[]>();

    for (const entry of checks) {
        const list = byScenario.get(entry.scenario) ?? [];

        list.push(entry);
        byScenario.set(entry.scenario, list);
    }

    for (const [scenario, list] of byScenario) {
        const failed = list.filter((entry) => !entry.ok);

        console.log(
            `  ${scenario}: ${list.length - failed.length}/${
                list.length
            } PASS${
                failed.length
                    ? ` — GAGAL: ${failed
                          .map((entry) => entry.name)
                          .join(", ")}`
                    : ""
            }`
        );
    }

    const failed = checks.filter((entry) => !entry.ok);

    /*
     * Only a FAILED check that was actually throttled counts as a
     * limiter artifact — a passing check may legitimately mention
     * "429=0" in its detail.
     */
    const throttled = checks.some(
        (entry) =>
            !entry.ok && entry.detail.includes("status=429")
    );

    if (throttled) {
        console.log(
            "\nCATATAN: ada respons 429 — budget enumerasi akses order guest bersifat in-memory " +
                "(10 permintaan tanpa otorisasi / 15 menit per IP). Jalankan harness ini pada dev server yang baru dijalankan."
        );
    }

    console.log(
        `\n${checks.length - failed.length}/${checks.length} pemeriksaan PASS`
    );

    if (failed.length > 0) {
        console.log("\nFAILED:");

        for (const entry of failed) {
            console.log(
                `  [${entry.scenario}] ${entry.name} — ${entry.detail}`
            );
        }
    }

    return failed.length;
}

main()
    .then(async (failed) => {
        await prisma.$disconnect();

        process.exit(failed === 0 ? 0 : 1);
    })
    .catch(async (error) => {
        console.error("\nE2E HARNESS ERROR:", error);

        try {
            await cleanup();
        } finally {
            await prisma.$disconnect();
        }

        process.exit(2);
    });
