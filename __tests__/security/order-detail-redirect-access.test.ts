/**
 * ==========================================================
 * OTP SUCCESS → ORDER DETAIL REDIRECT + MY ORDERS — ACCESS TESTS
 * ==========================================================
 *
 * The tracking page (`/lacak?pesanan=...`) is the surface the WhatsApp
 * bot links customers to. When the guest access cookie is gone, the
 * buyer restores access with the two-phase OTP; this suite pins what
 * happens AT AND AFTER that moment:
 *
 *   1. NAVIGATION. A verified code leads to the EXISTING order detail
 *      route (`/orders/[id]`), for THAT order, and the redirect carries
 *      the order id and nothing else — never the OTP, the guest token,
 *      the e-mail or the phone number.
 *   2. PROOF BEFORE NAVIGATION. The client cannot read an httpOnly
 *      cookie, so it re-reads the order through the ownership-guarded
 *      detail endpoint. Only a real success navigates; a denial is
 *      reported in place, which is what prevents a redirect loop.
 *   3. NO PRIVILEGE WIDENING. Recovering ONE order with an OTP issues a
 *      token for THAT order only. "Lihat Semua Pesanan Saya" therefore
 *      lists only the orders this browser already holds a valid guest
 *      cookie for — a shared phone number or e-mail never widens the
 *      list, and there is no order-search endpoint at all.
 *   4. IDOR. Customer A's cookie does not open customer B's order, and
 *      the answer is a uniform 404 (never 403), so sequential order ids
 *      cannot be used as an existence oracle.
 *   5. THE SESSION SURVIVES A REFRESH. Access travels in an httpOnly
 *      cookie, not in client storage, so reloading the page keeps it.
 *
 * The ownership assertions drive the REAL route handlers
 * (`GET /api/orders` and `GET /api/orders/[id]`) and the REAL
 * `confirmGuestRecovery` path with a mocked prisma + cookie jar. The
 * rendering assertions are STRUCTURAL (source-level) on purpose: this
 * project has no DOM test harness, so instead of pretending a component
 * rendered, they pin the invariants that can be checked without one, and
 * the decisions they depend on are covered by the pure helpers above.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "order-detail-redirect-test-secret";

/* Distinct client IP per test: the limiters below are real and shared. */
process.env.TRUSTED_PROXY = "1";

const mockCookieJar = {
    values: {} as Record<string, string>,
    throwOnRead: false,
};

jest.mock("next/headers", () => ({
    cookies: jest.fn(async () => {
        if (mockCookieJar.throwOnRead) {
            throw new Error("no request scope");
        }

        return {
            get: (name: string) =>
                mockCookieJar.values[name] === undefined
                    ? undefined
                    : {
                          name,
                          value: mockCookieJar.values[name],
                      },
            getAll: () =>
                Object.entries(mockCookieJar.values).map(
                    ([name, value]) => ({ name, value })
                ),
        };
    }),
}));

const mockOrder = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
};

const mockChallenge = {
    findUnique: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
        guestRecoveryChallenge: mockChallenge,
        $transaction: jest.fn(
            async (fn: (tx: unknown) => Promise<unknown>) =>
                fn({
                    guestRecoveryChallenge: mockChallenge,
                })
        ),
    },
}));

jest.mock("@/auth", () => ({ auth: jest.fn() }));

const mockSendRawNotificationNow = jest.fn();

jest.mock("@/lib/notification/order-status-handler", () => ({
    sendRawNotificationNow: (input: unknown) =>
        mockSendRawNotificationNow(input),
}));

/*
 * The list/detail routes import the checkout + payment modules. They are
 * never exercised here, so they are stubbed to keep the suite free of a
 * database, a payment provider or a WhatsApp session.
 */
jest.mock("@/lib/checkout", () => {
    const actual = jest.requireActual("@/lib/checkout");

    return {
        ...actual,
        createCheckoutOrder: jest.fn(),
        rollbackCheckoutOrder: jest.fn(),
    };
});

jest.mock("@/lib/payment/order-payment", () => {
    const actual = jest.requireActual(
        "@/lib/payment/order-payment"
    );

    return {
        ...actual,
        createDirectOrderPayment: jest.fn(),
    };
});

import { readFileSync } from "fs";
import { resolve } from "path";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

import {
    guestOrderCookieName,
    buildGuestOrderCookieValue,
    generateGuestAccessToken,
    guestAccessTokenExpiry,
    hashContact,
    hashGuestAccessToken,
    hashRecoveryCode,
    GUEST_ORDER_COOKIE_PREFIX,
} from "@/lib/guest-identity";
import { RECOVERY_CODE_MAX_ATTEMPTS } from "@/lib/guest-recovery";
import {
    ORDER_DETAIL_ROUTE,
    ORDERS_ROUTE,
    TRACKING_ROUTE,
    isOrderAccessGranted,
    normalizeOrderId,
    orderDetailPath,
    parseRecoveredOrder,
} from "@/lib/guest-order-navigation";

import { GET as listOrdersGET } from "@/app/api/orders/route";
import { GET as orderDetailGET } from "@/app/api/orders/[id]/route";
import { POST as confirmPOST } from "@/app/api/orders/recover/confirm/route";

const mockedAuth = auth as unknown as jest.Mock;
const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
};

const ORDER_A = {
    id: 101,
    orderNumber: "ORD-1700000000000-aaaaaaaa",
};
const ORDER_B = {
    id: 202,
    orderNumber: "ORD-1700000000000-bbbbbbbb",
};

/** Two buyers who (deliberately) share NOTHING, not even a phone prefix. */
const CONTACT_A = {
    email: "buyer-a@example.com",
    phone: "081200000001",
};
const CONTACT_B = {
    email: "buyer-b@example.com",
    phone: "081200000002",
};

let ipCounter = 0;

function nextIp(): string {
    ipCounter += 1;

    return `198.18.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

function orderRow(input: {
    id: number;
    userId?: string | null;
    token?: string | null;
    expiresAt?: Date | null;
}) {
    return {
        id: input.id,
        userId: input.userId ?? null,
        guestAccessTokenHash: input.token
            ? hashGuestAccessToken(input.token)
            : null,
        guestAccessTokenExpiresAt: input.expiresAt ?? null,
    };
}

/**
 * A complete row for `GET /api/orders/[id]`, which serializes every field
 * it projects. Nothing in the fixture is a secret the response should not
 * contain — it is the buyer's OWN order, read with the buyer's own
 * cookie.
 */
function detailOrderRow(order: {
    id: number;
    orderNumber: string;
}) {
    return {
        id: order.id,
        orderNumber: order.orderNumber,
        recipientName: "Budi",
        phone: CONTACT_A.phone,
        address: "Jl. Contoh 1",
        note: null,
        city: "Jakarta",
        district: "Gambir",
        province: "DKI Jakarta",
        postalCode: "10110",
        latitude: null,
        longitude: null,
        shippingCourier: "JNE",
        shippingService: "REG",
        trackingNumber: "JT1234567890",
        trackingUrl: null,
        shippingProvider: "MENGANTAR",
        providerCourier: "JNE",
        shipmentStatus: "IN_TRANSIT",
        subtotal: 90_000,
        shippingCost: 10_000,
        total: 100_000,
        status: "SHIPPED",
        paymentMethod: "COD",
        paymentStatus: "PAID",
        paidAt: null,
        createdAt: new Date("2026-10-01T10:00:00.000Z"),
        updatedAt: new Date("2026-10-02T10:00:00.000Z"),
        items: [],
    };
}

function detailRequest(orderId: number, ip: string): Request {
    return new Request(
        `https://mutiaraabadisnack.com/api/orders/${orderId}`,
        { headers: { "x-forwarded-for": ip } }
    );
}

async function getOrderDetail(
    orderId: number,
    ip: string
): Promise<{ status: number; body: unknown }> {
    const response = await orderDetailGET(
        detailRequest(orderId, ip),
        {
            params: Promise.resolve({
                id: String(orderId),
            }),
        }
    );

    return {
        status: response.status,
        body: await response.json(),
    };
}

beforeEach(() => {
    jest.clearAllMocks();

    mockCookieJar.values = {};
    mockCookieJar.throwOnRead = false;

    mockedAuth.mockResolvedValue(null);
    mockedOrder.update.mockResolvedValue({});
    mockChallenge.updateMany.mockResolvedValue({ count: 1 });
});

/* ==========================================
 * 1. THE NAVIGATION CONTRACT (PURE)
 * ========================================== */

describe("orderDetailPath", () => {
    test("points at the EXISTING order detail route", () => {
        expect(ORDER_DETAIL_ROUTE).toBe(ORDERS_ROUTE);
        expect(orderDetailPath(ORDER_A.id)).toBe(
            `${ORDER_DETAIL_ROUTE}/${ORDER_A.id}`
        );
        expect(orderDetailPath(String(ORDER_B.id))).toBe(
            `${ORDER_DETAIL_ROUTE}/${ORDER_B.id}`
        );
    });

    test("carries the id and NOTHING else", () => {
        /*
         * The security contract in one assertion: whatever is handed in,
         * the path is a fixed prefix plus digits. There is no room for an
         * OTP, a guest token, an e-mail or a phone number.
         */
        for (const id of [1, 42, ORDER_A.id, "7", "999999"]) {
            expect(orderDetailPath(id)).toMatch(
                /^\/orders\/\d+$/
            );
        }
    });

    test("refuses anything that is not a positive integer", () => {
        for (const value of [
            undefined,
            null,
            0,
            -1,
            1.5,
            NaN,
            Infinity,
            "",
            "   ",
            "abc",
            "12abc",
            "1e3",
            "101?token=leak",
            "101/../../admin",
            "101#x",
            {},
            [],
            ["101"],
            true,
        ]) {
            expect(orderDetailPath(value)).toBeNull();
            expect(normalizeOrderId(value)).toBeNull();
        }
    });

    test("no secret ever travels in the redirect target", () => {
        const rawToken = generateGuestAccessToken();
        const email = CONTACT_A.email;
        const phone = CONTACT_A.phone;

        const path = orderDetailPath(ORDER_A.id) ?? "";

        for (const secret of [rawToken, email, phone, "123456"]) {
            expect(path).not.toContain(secret);
            expect(path).not.toContain(
                encodeURIComponent(secret)
            );
        }

        /* No query string, no fragment, no path traversal. */
        expect(path).not.toContain("?");
        expect(path).not.toContain("#");
        expect(path).not.toContain("..");
    });
});

describe("parseRecoveredOrder", () => {
    test("reads the order reference from the confirm body", () => {
        expect(
            parseRecoveredOrder({
                id: ORDER_A.id,
                orderNumber: ORDER_A.orderNumber,
            })
        ).toEqual({
            id: ORDER_A.id,
            orderNumber: ORDER_A.orderNumber,
        });
    });

    test("tolerates a missing order number (display copy only)", () => {
        expect(parseRecoveredOrder({ id: 5 })).toEqual({
            id: 5,
            orderNumber: "",
        });
    });

    test("refuses a body with no usable id — so nothing navigates", () => {
        for (const data of [
            null,
            undefined,
            {},
            "ok",
            42,
            [],
            { id: null },
            { id: 0 },
            { id: -3 },
            { id: 2.5 },
            { id: "abc" },
            { id: "101?token=leak" },
        ]) {
            expect(parseRecoveredOrder(data)).toBeNull();
        }
    });
});

describe("isOrderAccessGranted", () => {
    test("only an explicit success counts", () => {
        expect(
            isOrderAccessGranted({
                ok: true,
                body: { success: true, data: {} },
            })
        ).toBe(true);

        for (const candidate of [
            null,
            { ok: false, body: { success: true } },
            { ok: true, body: { success: false } },
            { ok: true, body: null },
            { ok: true, body: "ok" },
            { ok: true, body: {} },
            { ok: false, body: { success: false } },
        ]) {
            expect(
                isOrderAccessGranted(candidate as never)
            ).toBe(false);
        }
    });
});

/* ==========================================
 * 2. OTP SUCCESS → THE RIGHT DETAIL PAGE
 * ========================================== */

describe("a verified OTP leads to the order it recovered", () => {
    /** Phase-1 challenge row, as confirmGuestRecovery reads it. */
    function challengeFixture() {
        return {
            id: "challenge-a",
            orderId: ORDER_A.id,
            orderNumber: ORDER_A.orderNumber,
            channel: "email",
            contactChannel: "email",
            contactHash: hashContact(CONTACT_A.email),
            codeHash: hashRecoveryCode(
                "challenge-a",
                "123456"
            ),
            attempts: 0,
            maxAttempts: RECOVERY_CODE_MAX_ATTEMPTS,
            deliveredAt: new Date(),
            deliveryError: null,
            consumedAt: null,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            notificationId: 7,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
    }

    function confirmRequest(ip: string, code = "123456"): Request {
        return new Request(
            "https://mutiaraabadisnack.com/api/orders/recover/confirm",
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-forwarded-for": ip,
                },
                body: JSON.stringify({
                    challengeId: "challenge-a",
                    code,
                    email: CONTACT_A.email,
                }),
            }
        );
    }

    /** The httpOnly cookie the confirm endpoint issued, by name. */
    function issuedCookie(
        setCookie: string
    ): { name: string; value: string } | null {
        const match = new RegExp(
            `(${GUEST_ORDER_COOKIE_PREFIX}${ORDER_A.id})=(\\d+\\.[A-Za-z0-9_-]+)`
        ).exec(setCookie);

        return match
            ? { name: match[1], value: match[2] }
            : null;
    }

    test("the code verifies, the cookie it sets unlocks THAT order, and the redirect target is that order's detail page", async () => {
        mockChallenge.findUnique.mockResolvedValue(
            challengeFixture()
        );
        mockedOrder.findUnique.mockResolvedValue({
            id: ORDER_A.id,
            orderNumber: ORDER_A.orderNumber,
            userId: null,
        });

        const response = await confirmPOST(
            confirmRequest(nextIp())
        );
        const body = await response.json();

        expect(response.status).toBe(200);

        /* 1. The buyer is told which order was restored. */
        const recovered = parseRecoveredOrder(body.data);

        expect(recovered).toEqual({
            id: ORDER_A.id,
            orderNumber: ORDER_A.orderNumber,
        });

        /* 2. The token travels ONLY in the httpOnly cookie. */
        const setCookie =
            response.headers.get("set-cookie") ?? "";

        expect(setCookie.toLowerCase()).toContain("httponly");
        expect(JSON.stringify(body)).not.toContain(
            "123456"
        );

        const cookie = issuedCookie(setCookie);

        expect(cookie).not.toBeNull();

        /*
         * 3. With that cookie the browser can now open the order — this
         *    is the check the client performs before navigating. The
         *    cookie, not the URL, is what carries the authorization.
         */
        mockCookieJar.values[cookie!.name] = cookie!.value;

        /* The order now stores the hash of the token the OTP minted. */
        const rawToken = cookie!.value.split(".")[1];

        mockedOrder.findUnique.mockResolvedValue(
            orderRow({
                id: ORDER_A.id,
                token: rawToken,
                expiresAt: guestAccessTokenExpiry(),
            })
        );

        mockedOrder.findFirst.mockResolvedValue(
            detailOrderRow(ORDER_A)
        );

        const detail = await getOrderDetail(
            ORDER_A.id,
            nextIp()
        );

        expect(detail.status).toBe(200);
        expect(
            isOrderAccessGranted({
                ok: true,
                body: detail.body,
            })
        ).toBe(true);

        /* 4. And the redirect target is exactly that order. */
        expect(
            orderDetailPath(recovered!.id)
        ).toBe(`/orders/${ORDER_A.id}`);

        /* The OTP itself never reaches the URL. */
        expect(
            orderDetailPath(recovered!.id)
        ).not.toContain("123456");
    });

    test("a WRONG code issues no cookie, so there is nothing to navigate to", async () => {
        mockChallenge.findUnique.mockResolvedValue(
            challengeFixture()
        );

        const response = await confirmPOST(
            confirmRequest(nextIp(), "000000")
        );

        expect(response.status).toBe(400);
        expect(response.headers.get("set-cookie")).toBeNull();

        const body = (await response.json()) as {
            data?: unknown;
        };

        /* No order reference → parseRecoveredOrder yields null. */
        expect(parseRecoveredOrder(body.data)).toBeNull();
    });

    test("an EXPIRED code issues no cookie and no redirect target", async () => {
        mockChallenge.findUnique.mockResolvedValue({
            ...challengeFixture(),
            expiresAt: new Date(Date.now() - 1_000),
        });

        const response = await confirmPOST(
            confirmRequest(nextIp())
        );

        expect(response.status).toBe(400);
        expect(response.headers.get("set-cookie")).toBeNull();
    });

    test("a REPLAYED code mints nothing (single use)", async () => {
        mockChallenge.findUnique.mockResolvedValue({
            ...challengeFixture(),
            consumedAt: new Date(),
        });

        const response = await confirmPOST(
            confirmRequest(nextIp())
        );

        expect(response.status).toBe(404);
        expect(response.headers.get("set-cookie")).toBeNull();
    });

    test("the OTP rules are untouched: TTL, attempts and single use stay in the library", () => {
        const source = readFileSync(
            resolve(
                process.cwd(),
                "lib/guest-recovery.ts"
            ),
            "utf-8"
        );

        expect(source).toContain(
            "RECOVERY_CODE_TTL_MS = 10 * 60 * 1000"
        );
        expect(source).toContain(
            `RECOVERY_CODE_MAX_ATTEMPTS = ${RECOVERY_CODE_MAX_ATTEMPTS}`
        );
        expect(source).toContain("consumedAt: null");
        expect(source).toContain("attempts: { increment: 1 }");

        /*
         * The challenge is bound to the exact checkout contact proven in
         * phase 1, so a stolen code alone is never enough.
         */
        expect(source).toContain("challenge.contactHash");

        /* And it is bound to ONE order — never to an identity. */
        expect(source).toContain("challenge.orderId");
    });
});

/* ==========================================
 * 3. THE DETAIL STAYS PROTECTED WITHOUT A COOKIE
 * ========================================== */

describe("with no (or an invalid) cookie the detail stays protected", () => {
    test("no cookie at all: a uniform 404, never the order", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            orderRow({
                id: ORDER_A.id,
                token: generateGuestAccessToken(),
                expiresAt: guestAccessTokenExpiry(),
            })
        );

        const detail = await getOrderDetail(
            ORDER_A.id,
            nextIp()
        );

        expect(detail.status).toBe(404);
        expect(detail.body).toEqual({
            success: false,
            message: "Pesanan tidak ditemukan.",
        });

        /* The probe therefore never authorizes a navigation. */
        expect(
            isOrderAccessGranted({
                ok: false,
                body: detail.body,
            })
        ).toBe(false);
    });

    test("guessing the id with a FOREIGN token is still a 404", async () => {
        mockCookieJar.values[
            guestOrderCookieName(ORDER_A.id)
        ] = buildGuestOrderCookieValue(
            ORDER_A.id,
            generateGuestAccessToken()
        );

        mockedOrder.findUnique.mockResolvedValue(
            orderRow({
                id: ORDER_A.id,
                token: generateGuestAccessToken(),
                expiresAt: guestAccessTokenExpiry(),
            })
        );

        const detail = await getOrderDetail(
            ORDER_A.id,
            nextIp()
        );

        expect(detail.status).toBe(404);
        expect(
            isOrderAccessGranted({
                ok: false,
                body: detail.body,
            })
        ).toBe(false);
    });

    test("an EXPIRED cookie is refused server-side even though the browser still sends it", async () => {
        const rawToken = generateGuestAccessToken();

        mockCookieJar.values[
            guestOrderCookieName(ORDER_A.id)
        ] = buildGuestOrderCookieValue(ORDER_A.id, rawToken);

        mockedOrder.findUnique.mockResolvedValue(
            orderRow({
                id: ORDER_A.id,
                token: rawToken,
                expiresAt: new Date(Date.now() - 60_000),
            })
        );

        const detail = await getOrderDetail(
            ORDER_A.id,
            nextIp()
        );

        expect(detail.status).toBe(401);
        expect(
            isOrderAccessGranted({
                ok: false,
                body: detail.body,
            })
        ).toBe(false);
    });

    test("a valid cookie opens the detail (the positive control)", async () => {
        const rawToken = generateGuestAccessToken();

        mockCookieJar.values[
            guestOrderCookieName(ORDER_A.id)
        ] = buildGuestOrderCookieValue(ORDER_A.id, rawToken);

        mockedOrder.findUnique.mockResolvedValue(
            orderRow({
                id: ORDER_A.id,
                token: rawToken,
                expiresAt: guestAccessTokenExpiry(),
            })
        );

        mockedOrder.findFirst.mockResolvedValue(
            detailOrderRow(ORDER_A)
        );

        const detail = await getOrderDetail(
            ORDER_A.id,
            nextIp()
        );

        expect(detail.status).toBe(200);
        expect(
            isOrderAccessGranted({
                ok: true,
                body: detail.body,
            })
        ).toBe(true);
    });
});

/* ==========================================
 * 4. IDOR — A's COOKIE, B's ORDER
 * ========================================== */

describe("IDOR", () => {
    test("customer A cannot open customer B's order", async () => {
        const tokenA = generateGuestAccessToken();

        /* A holds A's cookie… */
        mockCookieJar.values[
            guestOrderCookieName(ORDER_A.id)
        ] = buildGuestOrderCookieValue(ORDER_A.id, tokenA);

        /* …and tries B's order id. */
        mockedOrder.findUnique.mockResolvedValue(
            orderRow({
                id: ORDER_B.id,
                token: generateGuestAccessToken(),
                expiresAt: guestAccessTokenExpiry(),
            })
        );

        const detail = await getOrderDetail(
            ORDER_B.id,
            nextIp()
        );

        expect(detail.status).toBe(404);

        const serialized = JSON.stringify(detail.body);

        expect(serialized).not.toContain(ORDER_B.orderNumber);
        expect(serialized).not.toContain(CONTACT_B.email);
        expect(serialized).not.toContain(CONTACT_B.phone);
    });

    test("A's own order still opens in the same browser (no collateral damage)", async () => {
        const tokenA = generateGuestAccessToken();

        mockCookieJar.values[
            guestOrderCookieName(ORDER_A.id)
        ] = buildGuestOrderCookieValue(ORDER_A.id, tokenA);

        mockedOrder.findUnique.mockResolvedValue(
            orderRow({
                id: ORDER_A.id,
                token: tokenA,
                expiresAt: guestAccessTokenExpiry(),
            })
        );

        mockedOrder.findFirst.mockResolvedValue(
            detailOrderRow(ORDER_A)
        );

        expect(
            (await getOrderDetail(ORDER_A.id, nextIp()))
                .status
        ).toBe(200);
    });

    test("a forged cookie for B's id is never answered differently from a missing one", async () => {
        /*
         * B's order exists, but the caller presents a token that does not
         * match B's stored hash. The answer must be indistinguishable
         * from "no such order" (404 on both), so ids cannot be probed.
         */
        mockCookieJar.values[
            guestOrderCookieName(ORDER_B.id)
        ] = buildGuestOrderCookieValue(
            ORDER_B.id,
            generateGuestAccessToken()
        );

        mockedOrder.findUnique.mockResolvedValue(
            orderRow({
                id: ORDER_B.id,
                token: generateGuestAccessToken(),
                expiresAt: guestAccessTokenExpiry(),
            })
        );

        const existing = await getOrderDetail(
            ORDER_B.id,
            nextIp()
        );

        mockedOrder.findUnique.mockResolvedValue(null);

        const missing = await getOrderDetail(
            999_999,
            nextIp()
        );

        expect(existing.status).toBe(404);
        expect(missing.status).toBe(404);
        expect(existing.body).toEqual(missing.body);
    });

    test("the invalid order-id shape is rejected before any lookup", async () => {
        const response = await orderDetailGET(
            detailRequest(0, nextIp()),
            {
                params: Promise.resolve({ id: "abc" }),
            }
        );

        expect(response.status).toBe(400);
        expect(mockedOrder.findUnique).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 5. "LIHAT SEMUA PESANAN SAYA" — COOKIE-SCOPED ONLY
 * ========================================== */

describe("the order list is scoped by cookie, never by contact", () => {
    /** GET /api/orders wants the LIST shape; the token read wants hashes. */
    function findManyDispatcher(listRows: unknown[]) {
        return async (args: {
            select?: Record<string, unknown>;
        }) =>
            args?.select &&
            "guestAccessTokenHash" in args.select
                ? [
                      orderRow({
                          id: ORDER_A.id,
                          token: TOKEN_A,
                          expiresAt:
                              guestAccessTokenExpiry(),
                      }),
                  ]
                : listRows;
    }

    const TOKEN_A = generateGuestAccessToken();

    const LIST_ROW = {
        id: ORDER_A.id,
        orderNumber: ORDER_A.orderNumber,
        createdAt: new Date("2026-10-01T10:00:00.000Z"),
        status: "SHIPPED",
        paymentStatus: "PAID",
        paymentMethod: "COD",
        subtotal: 90_000,
        shippingCost: 10_000,
        total: 100_000,
        shippingProvider: "MENGANTAR",
        providerCourier: "JNE",
        shippingCourier: "JNE",
        shippingService: "REG",
        trackingNumber: "JT1234567890",
        shipmentStatus: "IN_TRANSIT",
    };

    test("one recovered order does NOT open the buyer's other orders", async () => {
        /*
         * The browser holds a cookie for ORDER_A ONLY — the one the OTP
         * restored. ORDER_B belongs to the SAME person (same phone at
         * checkout) but this browser never proved anything about it, so
         * it must not appear.
         */
        mockCookieJar.values[
            guestOrderCookieName(ORDER_A.id)
        ] = buildGuestOrderCookieValue(ORDER_A.id, TOKEN_A);

        mockedOrder.findMany.mockImplementation(
            findManyDispatcher([LIST_ROW])
        );

        const response = await listOrdersGET();
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data.map((order: { id: number }) => order.id)).toEqual(
            [ORDER_A.id]
        );

        /* And the scope really was the cookie-backed id set. */
        const listCall = mockedOrder.findMany.mock.calls.find(
            ([args]) =>
                !(
                    args?.select &&
                    "guestAccessTokenHash" in args.select
                )
        );

        expect(listCall?.[0].where).toEqual({
            id: { in: [ORDER_A.id] },
        });
    });

    test("a phone number or e-mail in the request cannot widen the list", () => {
        /*
         * `GET /api/orders` takes NO request argument at all, so there is
         * no client-supplied contact for it to filter on. That is the
         * structural half of the guarantee; the behavioural half is that
         * the ONLY scope used is the verified cookie set.
         */
        expect(listOrdersGET.length).toBe(0);
    });

    test("an expired cookie is dropped from the list entirely", async () => {
        mockCookieJar.values[
            guestOrderCookieName(ORDER_A.id)
        ] = buildGuestOrderCookieValue(ORDER_A.id, TOKEN_A);

        mockedOrder.findMany.mockImplementation(async () => [
            orderRow({
                id: ORDER_A.id,
                token: TOKEN_A,
                expiresAt: new Date(Date.now() - 1_000),
            }),
        ]);

        const response = await listOrdersGET();
        const body = await response.json();

        expect(body.data).toEqual([]);

        /* Nothing was even queried for the list. */
        expect(
            mockedOrder.findMany
        ).toHaveBeenCalledTimes(1);
    });

    test("no cookie and no session yields an empty list, never other people's orders", async () => {
        const response = await listOrdersGET();
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ success: true, data: [] });
        expect(mockedOrder.findMany).not.toHaveBeenCalled();
    });

    test("the list endpoint is not a search surface and never returns personal data", async () => {
        mockCookieJar.values[
            guestOrderCookieName(ORDER_A.id)
        ] = buildGuestOrderCookieValue(ORDER_A.id, TOKEN_A);

        mockedOrder.findMany.mockImplementation(
            findManyDispatcher([LIST_ROW])
        );

        await listOrdersGET();

        const listCall = mockedOrder.findMany.mock.calls.find(
            ([args]) =>
                !(
                    args?.select &&
                    "guestAccessTokenHash" in args.select
                )
        );

        const select = Object.keys(listCall?.[0].select ?? {});

        /* Everything the card needs is there… */
        for (const field of [
            "id",
            "orderNumber",
            "createdAt",
            "total",
            "status",
            "paymentStatus",
            "shippingCourier",
            "shippingService",
            "trackingNumber",
            "shipmentStatus",
        ]) {
            expect(select).toContain(field);
        }

        /* …and nothing else is even read. */
        for (const field of [
            "address",
            "phone",
            "recipientName",
            "customerEmail",
            "paymentNo",
            "qrString",
            "guestAccessTokenHash",
            "guestIdentityKey",
            "userId",
        ]) {
            expect(select).not.toContain(field);
        }

        /* No filter on any contact value exists in the query. */
        expect(
            JSON.stringify(listCall?.[0])
        ).not.toMatch(/phone|customerEmail|guestIdentityKey/);
    });

    test("the new list is not reachable through any public order-search endpoint", () => {
        const route = readFileSync(
            resolve(
                process.cwd(),
                "app/api/orders/route.ts"
            ),
            "utf-8"
        );

        const getSection = route.substring(
            route.indexOf("export async function GET")
        );

        /* The GET handler cannot be influenced by request input… */
        expect(getSection).toMatch(
            /export async function GET\(\)\s*\{/
        );

        /* …and derives its scope from the cookie / session only. */
        expect(getSection).toContain(
            "listGuestAccessibleOrderIds"
        );
        expect(getSection).toContain(
            "session.user.id"
        );
    });
});

/* ==========================================
 * 6. A REFRESH KEEPS A VALID GUEST SESSION
 * ========================================== */

describe("reloading the page keeps a valid guest session", () => {
    test("the same cookie authorizes again after a re-read", async () => {
        const rawToken = generateGuestAccessToken();

        mockCookieJar.values[
            guestOrderCookieName(ORDER_A.id)
        ] = buildGuestOrderCookieValue(ORDER_A.id, rawToken);

        mockedOrder.findUnique.mockResolvedValue(
            orderRow({
                id: ORDER_A.id,
                token: rawToken,
                expiresAt: guestAccessTokenExpiry(),
            })
        );

        mockedOrder.findFirst.mockResolvedValue(
            detailOrderRow(ORDER_A)
        );

        /* First render… */
        expect(
            (await getOrderDetail(ORDER_A.id, nextIp()))
                .status
        ).toBe(200);

        /* …a refresh re-sends the same cookie from the same jar. */
        expect(
            (await getOrderDetail(ORDER_A.id, nextIp()))
                .status
        ).toBe(200);
    });

    test("the session is carried by an httpOnly cookie, not client storage", () => {
        for (const file of [
            "components/orders/OrderRecovery.tsx",
            "components/orders/TrackingLookup.tsx",
            "components/orders/OrdersPage.tsx",
            "components/orders/ShipmentTrackingPanel.tsx",
            "app/lacak/page.tsx",
            "app/orders/[id]/page.tsx",
        ]) {
            const source = readFileSync(
                resolve(process.cwd(), file),
                "utf-8"
            );

            /* A reload must not depend on anything a refresh clears. */
            expect(source).not.toContain("sessionStorage");
            expect(source).not.toContain("localStorage");

            /* And the token must never be readable from JavaScript. */
            expect(source).not.toContain(
                "document.cookie"
            );
        }
    });
});

/* ==========================================
 * 7. STRUCTURAL GUARDS (no DOM harness)
 * ========================================== */

function readSource(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

describe("the redirect is built from the order id alone", () => {
    const recovery = readSource(
        "components/orders/OrderRecovery.tsx"
    );

    const lookup = readSource(
        "components/orders/TrackingLookup.tsx"
    );

    test("the tracking page navigates with the shared path helper", () => {
        expect(lookup).toContain(
            "orderDetailPath(order.id)"
        );
        expect(lookup).toContain("router.replace(path)");
    });

    test("the recovery form only navigates through the caller's handler", () => {
        expect(recovery).toContain("onRecovered");

        /*
         * The ONLY navigation the form performs by itself is a reload of
         * the page it is already on. Every URL is either a literal API
         * path or built by the caller.
         */
        expect(recovery).toContain(
            "window.location.reload()"
        );
        expect(recovery).not.toContain(
            "window.location.assign"
        );
        expect(recovery).not.toContain("window.location.href");
    });

    test("no OTP, token, e-mail or phone number can reach a URL", () => {
        const recoveryCode = stripComments(recovery);
        const lookupCode = stripComments(lookup);

        for (const source of [recoveryCode, lookupCode]) {
            /* No query-string assembly at all. */
            expect(source).not.toContain(
                "URLSearchParams"
            );
            expect(source).not.toContain(
                "window.location.search"
            );

            /* The only fetches are literal, query-free paths. */
            const fetches =
                source.match(/fetch\(\s*`?[^)]*`?\s*[,)]/g) ??
                [];

            for (const call of fetches) {
                expect(call).not.toContain("?");
            }
        }

        /* The order id is the single navigation input. */
        expect(lookupCode).toContain("orderDetailPath");
        expect(recoveryCode).not.toMatch(
            /\/(orders|admin|dashboard)\$\{/
        );
    });

    test("the recovery probe reads the ownership-guarded detail endpoint, uncached", () => {
        expect(recovery).toContain(
            "`/api/orders/${orderId}`"
        );

        /* A cached 404 from before the cookie existed must never be reused. */
        expect(recovery).toMatch(
            /cache:\s*"no-store"/
        );

        expect(recovery).toContain(
            "isOrderAccessGranted"
        );
    });

    test("the order detail page offers both navigation options, query-free", () => {
        const detail = readSource(
            "app/orders/[id]/page.tsx"
        );

        expect(detail).toContain(
            "Lihat Semua Pesanan Saya"
        );
        expect(detail).toContain("Lacak Pesanan Lain");
        expect(detail).toContain(`href="${ORDERS_ROUTE}"`);
        expect(detail).toContain(`href="${TRACKING_ROUTE}"`);
    });

    test("the tracking panel offers the same two navigation options", () => {
        const panel = readSource(
            "components/orders/ShipmentTrackingPanel.tsx"
        );

        expect(panel).toContain("Lihat Semua Pesanan Saya");
        expect(panel).toContain("Lacak Pesanan Lain");
        expect(panel).toContain('href="/orders"');
        expect(panel).toContain('href="/lacak"');

        /* Still read-only and still query-free. */
        expect(panel).not.toMatch(
            /method:\s*"(POST|PUT|PATCH|DELETE)"/
        );
        expect(panel).not.toContain("href={`/orders/");
    });

    test("the order card shows the shipping facts, and the list hides personal data", () => {
        const page = readSource(
            "components/orders/OrdersPage.tsx"
        );
        const pageCode = stripComments(page);

        /* Requirement 3 — the card's contents. */
        expect(pageCode).toContain("order.orderNumber");
        expect(pageCode).toContain("formatDate(");
        expect(pageCode).toContain("order.total");
        expect(pageCode).toContain("StatusBadge");
        expect(pageCode).toContain("SHIPMENT_STAGE_LABELS");
        expect(pageCode).toContain(
            "resolveShipmentStage"
        );
        expect(pageCode).toContain(
            "order.providerCourier"
        );
        expect(pageCode).toContain(
            "order.trackingNumber"
        );
        expect(pageCode).toContain("Lihat Detail");
        expect(pageCode).toContain("/orders/${order.id}");

        /* No unnecessary personal data is read or rendered. */
        for (const field of [
            "address",
            "phone",
            "customerEmail",
            "recipientName",
            "paymentNo",
            "qrString",
            "guestAccessToken",
        ]) {
            expect(pageCode).not.toContain(field);
        }
    });

    test("the redirect helper is the single source of the target path", () => {
        const helper = readSource(
            "lib/guest-order-navigation.ts"
        );

        expect(helper).toContain(
            'return `${ORDER_DETAIL_ROUTE}/${id}`'
        );

        /* It is built from a validated integer and a fixed prefix. */
        expect(helper).toContain("Number.isSafeInteger(value)");
        expect(helper).toContain("parsed > 0");

        /* A string id must be plain digits — never "1e3" or "0x10". */
        expect(helper).toMatch(/\/\^\\d\+\$\//);
    });
});
