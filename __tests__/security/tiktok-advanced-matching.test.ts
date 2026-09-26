/**
 * ==========================================
 * TIKTOK ADVANCED MATCHING + CATALOG SIGNALS
 * ==========================================
 *
 * Covers the two Events Manager diagnostics:
 *
 *   A. matching keys  — email / phone / external_id are normalized
 *      and SHA-256 hashed, never sent raw, and OMITTED when the
 *      application does not legitimately have them.
 *   B. catalog signals — content_id / contents / content_type /
 *      content_name / price / quantity / value / currency on
 *      ViewContent, AddToCart, InitiateCheckout, AddPaymentInfo
 *      and CompletePayment.
 *
 * No test ever talks to TikTok production: fetch is mocked and no
 * raw customer identifier is ever placed in a fixture.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

/* ==========================================
 * MOCKS
 * ========================================== */

const mockPrisma = {
    storeSetting: {
        findUnique: jest.fn(),
    },
    user: {
        findUnique: jest.fn(),
    },
};

jest.mock("@/lib/prisma", () => ({
    prisma: mockPrisma,
}));

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

import { auth } from "@/auth";

import {
    buildTikTokUserMatch,
    hashTikTokMatchEmail,
    hashTikTokMatchExternalId,
    hashTikTokMatchPhone,
    hasTikTokUserMatch,
    normalizeTikTokMatchEmail,
    normalizeTikTokMatchPhone,
} from "@/lib/analytics/tiktok-user-match";

import {
    TIKTOK_CONTENT_TYPE_PRODUCT,
    TIKTOK_CURRENCY,
    buildTikTokCartProperties,
    buildTikTokContent,
    buildTikTokContents,
    buildTikTokOrderProperties,
    buildTikTokProductProperties,
    resolveTikTokContentId,
    toTikTokAmount,
    toTikTokQuantity,
} from "@/lib/analytics/tiktok-catalog";

import {
    TIKTOK_EVENTS_API_URL,
    trackTikTokServerCompletePayment,
} from "@/lib/analytics/tiktok-events-api";

import { whenTikTokPixelReady } from "@/lib/analytics/tiktok";

import { GET } from "@/app/api/analytics/tiktok-match/route";

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

/* ==========================================
 * FIXTURES — digests only, no raw identity
 * ========================================== */

const PIXEL_ID = "C1A2B3C4D5E6F7G8H9J0";
const TOKEN = "act.example-access-token-0000wxyz";

/** sha256("buyer@example.com") */
const EMAIL_HASH =
    "6a6c26195c3682faa816966af789717c3bfa834eee6c599d667d2b3429c27cfd";

/** sha256("+628123456789") — TikTok E.164 form */
const PHONE_HASH =
    "df8990bcc7cb6688c3adff3a223504d766a0604568aa9412da6425c4efc5bbc7";

/** sha256("user_abc123") */
const EXTERNAL_ID_HASH =
    "5a2e084061eae2209d14bb47650ce453f9b053745e55d0475bb9c3d695193b38";

/** sha256("") — the classic "hash of nothing" failure mode. */
const EMPTY_STRING_HASH =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function jsonResponse(
    body: unknown,
    status = 200
): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as unknown as Response;
}

beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockReset();
});

/* ==========================================
 * A. USER MATCHING — NORMALIZATION + SHA-256
 * ========================================== */

describe("TikTok user matching — email", () => {
    test("normalizes exactly like TikTok: trim + lowercase", () => {
        expect(
            normalizeTikTokMatchEmail(
                "  Buyer@Example.COM "
            )
        ).toBe("buyer@example.com");
    });

    test("hashes the normalized email with SHA-256", () => {
        expect(
            hashTikTokMatchEmail("buyer@example.com")
        ).toBe(EMAIL_HASH);

        /* Same digest regardless of how the user typed it. */
        expect(
            hashTikTokMatchEmail(" Buyer@EXAMPLE.com ")
        ).toBe(EMAIL_HASH);
    });

    test("is deterministic across calls", () => {
        expect(
            hashTikTokMatchEmail("buyer@example.com")
        ).toBe(
            hashTikTokMatchEmail("buyer@example.com")
        );
    });

    test("omits unusable values instead of hashing them", () => {
        for (const value of [
            "",
            "   ",
            null,
            undefined,
            123,
            {},
            "not-an-email",
            "a@b",
            "a b@c.com",
            "@example.com",
            "buyer@",
            `${"a".repeat(250)}@example.com`,
        ]) {
            expect(
                normalizeTikTokMatchEmail(value)
            ).toBeNull();
            expect(
                hashTikTokMatchEmail(value)
            ).toBeNull();
        }
    });
});

describe("TikTok user matching — phone", () => {
    test("converts local Indonesian formats to E.164", () => {
        for (const value of [
            "08123456789",
            "0812-3456-789",
            "0812 3456 789",
            "(0812) 3456-789",
            "628123456789",
            "+62 812 3456 789",
            "+628123456789",
            "8123456789",
        ]) {
            expect(
                normalizeTikTokMatchPhone(value)
            ).toBe("+628123456789");
        }
    });

    test("keeps the leading plus in the hashed value (TikTok rule)", () => {
        expect(
            hashTikTokMatchPhone("08123456789")
        ).toBe(PHONE_HASH);

        expect(
            hashTikTokMatchPhone("+628123456789")
        ).toBe(PHONE_HASH);
    });

    test("keeps an already-international non-62 number", () => {
        expect(
            normalizeTikTokMatchPhone(
                "+1 (213) 373-4253"
            )
        ).toBe("+12133734253");
    });

    test("drops numbers it cannot place in a country", () => {
        for (const value of [
            "",
            "   ",
            null,
            undefined,
            42,
            {},
            "abc",
            "+",
            "123",
            "0000",
            "123456789012345678",
        ]) {
            expect(
                normalizeTikTokMatchPhone(value)
            ).toBeNull();
            expect(
                hashTikTokMatchPhone(value)
            ).toBeNull();
        }
    });
});

describe("TikTok user matching — external id + assembly", () => {
    test("hashes the trimmed external id", () => {
        expect(
            hashTikTokMatchExternalId(
                "  user_abc123  "
            )
        ).toBe(EXTERNAL_ID_HASH);
    });

    test("builds only the keys the app actually has", () => {
        expect(
            buildTikTokUserMatch({
                email: "buyer@example.com",
                phone: "08123456789",
                externalId: "user_abc123",
            })
        ).toEqual({
            email: EMAIL_HASH,
            phone: PHONE_HASH,
            external_id: EXTERNAL_ID_HASH,
        });

        /* Email only: the other keys must be ABSENT, not empty. */
        const emailOnly = buildTikTokUserMatch({
            email: "buyer@example.com",
        });

        expect(emailOnly).toEqual({
            email: EMAIL_HASH,
        });
        expect(emailOnly).not.toHaveProperty("phone");
        expect(emailOnly).not.toHaveProperty(
            "external_id"
        );
    });

    test("no data → empty object, never a hash of nothing", () => {
        const match = buildTikTokUserMatch({
            email: null,
            phone: "",
            externalId: undefined,
        });

        expect(match).toEqual({});
        expect(hasTikTokUserMatch(match)).toBe(false);
        expect(hasTikTokUserMatch(null)).toBe(false);

        const serialized = JSON.stringify(match);

        expect(serialized).not.toContain(
            EMPTY_STRING_HASH
        );
        expect(serialized).not.toContain("null");
    });

    test("raw identity never survives the helper", () => {
        const match = buildTikTokUserMatch({
            email: "buyer@example.com",
            phone: "08123456789",
            externalId: "user_abc123",
        });

        const serialized = JSON.stringify(match);

        expect(serialized).not.toContain(
            "buyer@example.com"
        );
        expect(serialized).not.toContain(
            "08123456789"
        );
        expect(serialized).not.toContain("user_abc123");
    });
});

/* ==========================================
 * B/C/D. PRODUCT / CATALOG PARAMETERS
 * ========================================== */

describe("TikTok content_id resolution", () => {
    test("Phase 14: catalog id is the product id, never slug/order id", () => {
        expect(
            resolveTikTokContentId({ productId: 123 })
        ).toBe("123");

        expect(
            resolveTikTokContentId({ productId: 123 })
        ).not.toBe("produk-a");

        expect(
            resolveTikTokContentId({ productId: 123 })
        ).not.toBe("944");

        expect(
            resolveTikTokContentId({ productId: 123 })
        ).not.toBe("PAY-BN-1789711955959");
    });

    test("a real SKU always wins when the caller has one", () => {
        expect(
            resolveTikTokContentId({
                sku: "ABC123",
                productId: 123,
            })
        ).toBe("ABC123");
    });

    test("falls back to the variant only when the product is gone", () => {
        expect(
            resolveTikTokContentId({
                productId: null,
                variantId: 7,
            })
        ).toBe("7");

        expect(
            resolveTikTokContentId({
                productId: null,
                variantId: null,
            })
        ).toBeNull();
    });

    test("numeric database types are normalized", () => {
        expect(
            resolveTikTokContentId({ productId: "42" })
        ).toBe("42");
        expect(
            resolveTikTokContentId({ productId: 0 })
        ).toBe("0");
        expect(
            resolveTikTokContentId({ sku: "   " , productId: 8 })
        ).toBe("8");
    });
});

describe("TikTok money helpers", () => {
    test("accepts Prisma Decimal strings and rounds float noise", () => {
        expect(toTikTokAmount("25000.00")).toBe(25000);
        expect(toTikTokAmount(0)).toBe(0);
        expect(toTikTokAmount(0.1 * 3)).toBe(0.3);
        expect(
            toTikTokAmount("45000.000000000004")
        ).toBe(45000);
    });

    test("rejects nonsense instead of sending 0", () => {
        expect(toTikTokAmount(null)).toBeUndefined();
        expect(
            toTikTokAmount(undefined)
        ).toBeUndefined();
        expect(toTikTokAmount("N/A")).toBeUndefined();
        expect(toTikTokAmount(-5)).toBeUndefined();
        expect(toTikTokQuantity(0)).toBeUndefined();
        expect(
            toTikTokQuantity("x")
        ).toBeUndefined();
        expect(toTikTokQuantity(2)).toBe(2);
    });
});

describe("ViewContent properties", () => {
    test("carries content_id, contents, content_type, name, price, currency", () => {
        const properties =
            buildTikTokProductProperties({
                productId: 42,
                productName:
                    "Kripik Kue Kuping Gajah",
                price: "25000.00",
            });

        expect(properties.content_id).toBe("42");
        expect(properties.content_type).toBe(
            TIKTOK_CONTENT_TYPE_PRODUCT
        );
        expect(properties.content_name).toBe(
            "Kripik Kue Kuping Gajah"
        );
        expect(properties.price).toBe(25000);
        expect(properties.currency).toBe("IDR");
        expect(properties.contents).toEqual([
            {
                content_id: "42",
                content_type: "product",
                content_name:
                    "Kripik Kue Kuping Gajah",
                price: 25000,
            },
        ]);

        /* A page view never claims a quantity it does not have. */
        expect(properties).not.toHaveProperty(
            "quantity"
        );
        expect(properties).not.toHaveProperty("value");
    });
});

describe("AddToCart properties", () => {
    test("adds quantity and the matching line value", () => {
        const properties =
            buildTikTokProductProperties(
                {
                    productId: 42,
                    productName: "Kaos",
                    price: "15000.00",
                    quantity: 2,
                },
                { withQuantity: true }
            );

        expect(properties.content_id).toBe("42");
        expect(properties.quantity).toBe(2);
        expect(properties.value).toBe(30000);
        expect(properties.price).toBe(15000);
        expect(properties.currency).toBe("IDR");

        expect(properties.contents).toEqual([
            {
                content_id: "42",
                content_type: "product",
                content_name: "Kaos",
                quantity: 2,
                price: 15000,
            },
        ]);
    });
});

describe("multi-product contents", () => {
    test("cart properties describe every line, never the order id", () => {
        const properties = buildTikTokCartProperties(
            [
                {
                    productId: 1,
                    variantId: 11,
                    productName: "Produk A",
                    quantity: 2,
                    price: 15000,
                },
                {
                    productId: 2,
                    variantId: 22,
                    productName: "Produk B",
                    quantity: 1,
                    price: 25000,
                },
            ],
            { value: 55000 }
        );

        expect(properties.contents).toEqual([
            {
                content_id: "1",
                content_type: "product",
                content_name: "Produk A",
                quantity: 2,
                price: 15000,
            },
            {
                content_id: "2",
                content_type: "product",
                content_name: "Produk B",
                quantity: 1,
                price: 25000,
            },
        ]);

        expect(properties.num_items).toBe(2);
        expect(properties.value).toBe(55000);
        expect(properties.currency).toBe("IDR");
        expect(properties.content_type).toBe(
            TIKTOK_CONTENT_TYPE_PRODUCT
        );
    });

    test("extra properties are merged without clobbering standards", () => {
        const properties = buildTikTokCartProperties(
            [
                {
                    productId: 1,
                    productName: "Produk A",
                    quantity: 1,
                    price: 1000,
                },
            ],
            {
                value: 1000,
                extra: {
                    payment_method: "QRIS",
                },
            }
        );

        expect(properties.payment_method).toBe(
            "QRIS"
        );
        expect(properties.currency).toBe("IDR");
    });

    test("items without any usable id are skipped", () => {
        expect(
            buildTikTokContents([
                { productId: null, variantId: null },
                { productId: 5, productName: "Kaos" },
            ])
        ).toEqual([
            {
                content_id: "5",
                content_type: "product",
                content_name: "Kaos",
            },
        ]);

        expect(buildTikTokContent({})).toBeNull();
        expect(
            buildTikTokCartProperties([])
        ).not.toHaveProperty("contents");
    });
});

describe("CompletePayment properties (order level)", () => {
    test("uses the authoritative total and per-line contents", () => {
        const properties =
            buildTikTokOrderProperties(
                [
                    {
                        productId: 4,
                        variantId: 7,
                        productName: "Kripik",
                        quantity: 2,
                        price: "25000.00",
                    },
                ],
                {
                    value: "75000.00",
                    orderId: "PAY-CART-555",
                }
            );

        expect(properties.value).toBe(75000);
        expect(properties.currency).toBe("IDR");
        expect(properties.order_id).toBe(
            "PAY-CART-555"
        );
        expect(properties.contents).toEqual([
            {
                content_id: "4",
                content_type: "product",
                content_name: "Kripik",
                quantity: 2,
                price: 25000,
            },
        ]);

        /* The order number is never a content id. */
        expect(properties.content_id).toBeUndefined();
        expect(properties).not.toHaveProperty(
            "num_items"
        );
    });
});

/* ==========================================
 * E. SERVER EVENTS API PAYLOAD
 * ========================================== */

describe("TikTok Events API — matching keys", () => {
    beforeEach(() => {
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            {
                tiktokPixelEnabled: true,
                tiktokPixelId: PIXEL_ID,
                tiktokPixelAccessToken: TOKEN,
            }
        );

        fetchMock.mockResolvedValue(
            jsonResponse({ code: 0, message: "OK" })
        );
    });

    test("CompletePayment sends hashed email/phone/external_id", async () => {
        await trackTikTokServerCompletePayment({
            orderNumber: "PAY-CART-555",
            total: "75000.00",
            items: [
                {
                    id: 826,
                    productId: 4,
                    variantId: 7,
                    productName: "Kripik",
                    variantName: "1KG",
                    quantity: 2,
                    price: "25000.00",
                },
                {
                    id: 827,
                    productId: 5,
                    variantId: 9,
                    productName: "Keripik",
                    quantity: 1,
                    price: 25000,
                },
            ],
            email: "  Buyer@Example.COM ",
            phone: "08123456789",
            userId: "user_abc123",
        });

        const body = JSON.parse(
            fetchMock.mock.calls[0][1].body
        );

        expect(body.event_source).toBe("web");
        expect(body.event_source_id).toBe(
            PIXEL_ID
        );
        expect(body.data[0].event).toBe(
            "CompletePayment"
        );
        expect(body.data[0].event_id).toBe(
            "ttq:completepayment:PAY-CART-555"
        );

        expect(body.data[0].user).toEqual({
            email: EMAIL_HASH,
            phone: PHONE_HASH,
            external_id: EXTERNAL_ID_HASH,
        });

        /* Product/catalog parameters come from the order rows. */
        expect(
            body.data[0].properties.contents
        ).toEqual([
            {
                content_id: "4",
                content_type: "product",
                content_name: "Kripik",
                quantity: 2,
                price: 25000,
            },
            {
                content_id: "5",
                content_type: "product",
                content_name: "Keripik",
                quantity: 1,
                price: 25000,
            },
        ]);

        expect(
            body.data[0].properties.value
        ).toBe(75000);
        expect(
            body.data[0].properties.currency
        ).toBe(TIKTOK_CURRENCY);
        expect(
            body.data[0].properties.order_id
        ).toBe("PAY-CART-555");
    });

    test("no raw PII, no token, in the request body", async () => {
        await trackTikTokServerCompletePayment({
            orderNumber: "PAY-CART-556",
            total: 10000,
            items: [],
            email: "buyer@example.com",
            phone: "08123456789",
            userId: "user_abc123",
        });

        const serialized =
            fetchMock.mock.calls[0][1].body;

        expect(serialized).not.toContain(
            "buyer@example.com"
        );
        expect(serialized).not.toContain(
            "Buyer@Example.COM"
        );
        expect(serialized).not.toContain(
            "08123456789"
        );
        expect(serialized).not.toContain(
            "+628123456789"
        );
        expect(serialized).not.toContain(
            "user_abc123"
        );
        expect(serialized).not.toContain(TOKEN);
    });

    test("an order without email/phone omits the user object entirely", async () => {
        await trackTikTokServerCompletePayment({
            orderNumber: "PAY-CART-557",
            total: 10000,
            items: [],
            email: null,
            phone: null,
        });

        const body = JSON.parse(
            fetchMock.mock.calls[0][1].body
        );

        expect(body.data[0]).not.toHaveProperty(
            "user"
        );

        const serialized = JSON.stringify(body);

        expect(serialized).not.toContain(
            EMPTY_STRING_HASH
        );
    });

    test("hits the documented endpoint and never throws", async () => {
        fetchMock.mockRejectedValue(
            new Error("tiktok down")
        );

        await expect(
            trackTikTokServerCompletePayment({
                orderNumber: "PAY-CART-558",
                total: 1000,
                items: [],
            })
        ).resolves.toMatchObject({ ok: false });

        expect(
            fetchMock.mock.calls[0][0]
        ).toBe(TIKTOK_EVENTS_API_URL);

        expect(
            fetchMock.mock.calls[0][1].headers[
                "Access-Token"
            ]
        ).toBe(TOKEN);
    });
});

/* ==========================================
 * F. BROWSER MATCHING ENDPOINT
 * ========================================== */

describe("GET /api/analytics/tiktok-match", () => {
    test("anonymous visitors get nothing and no lookup", async () => {
        (auth as jest.Mock).mockResolvedValue(null);

        const response = await GET();
        const body = await response.json();

        expect(body).toEqual({
            success: true,
            data: {},
        });
        expect(
            mockPrisma.user.findUnique
        ).not.toHaveBeenCalled();
    });

    test("returns NORMALIZED RAW identifiers for the logged-in customer", async () => {
        (auth as jest.Mock).mockResolvedValue({
            user: { id: "user_abc123" },
        });

        mockPrisma.user.findUnique.mockResolvedValue(
            {
                email: "buyer@example.com",
                phone: "08123456789",
            }
        );

        const response = await GET();
        const body = await response.json();

        /*
         * Documented contract: the BROWSER Pixel auto-hashes with
         * SHA-256, so `ttq.identify()` must receive the normalized
         * RAW value — NOT a pre-computed digest (which the Pixel
         * would hash again). Server-side Events API hashing is
         * unchanged and covered separately.
         */
        expect(body.data).toEqual({
            email: "buyer@example.com",
            phone_number: "+628123456789",
            external_id: "user_abc123",
        });

        /* Explicit select: never the whole row, never the password. */
        expect(
            mockPrisma.user.findUnique
        ).toHaveBeenCalledWith({
            where: { id: "user_abc123" },
            select: {
                email: true,
                phone: true,
            },
        });

        const serialized = JSON.stringify(body);

        /* Never the secret columns, whatever the payload shape. */
        expect(serialized).not.toContain("password");
        expect(serialized).not.toContain("tiktokPixel");
        expect(serialized).not.toContain("accessToken");

        expect(
            response.headers.get("Cache-Control")
        ).toContain("no-store");
    });

    test("a lookup failure degrades to an empty match", async () => {
        (auth as jest.Mock).mockResolvedValue({
            user: { id: "user_abc123" },
        });

        mockPrisma.user.findUnique.mockRejectedValue(
            new Error("db down")
        );

        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const response = await GET();
        const body = await response.json();

        expect(body.data).toEqual({});

        /* A failure must not log identity data. */
        expect(errorSpy).not.toHaveBeenCalled();

        errorSpy.mockRestore();
    });
});

/* ==========================================
 * F2. PIXEL READINESS — EVENTS ARE NOT LOST
 * ========================================== */

describe("whenTikTokPixelReady", () => {
    /**
     * Minimal window stub: the readiness helper only needs
     * `ttq` plus event listener support.
     */
    function setWindow(
        value: Record<string, unknown>
    ) {
        const listeners = new Map<
            string,
            Set<() => void>
        >();

        (globalThis as { window?: unknown }).window = {
            ...value,
            addEventListener: (
                event: string,
                handler: () => void
            ) => {
                if (!listeners.has(event)) {
                    listeners.set(
                        event,
                        new Set()
                    );
                }

                listeners
                    .get(event)!
                    .add(handler);
            },
            removeEventListener: (
                event: string,
                handler: () => void
            ) => {
                listeners.get(event)?.delete(handler);
            },
            dispatchEvent: (event: {
                type: string;
            }) => {
                for (const handler of listeners.get(
                    event.type
                ) ?? []) {
                    handler();
                }

                return true;
            },
        };
    }

    afterEach(() => {
        jest.useRealTimers();
        delete (globalThis as { window?: unknown })
            .window;
    });

    test("fires immediately when the pixel is already loaded", () => {
        setWindow({ ttq: { track: jest.fn() } });

        const callback = jest.fn();
        const cancel = whenTikTokPixelReady(callback);

        expect(callback).toHaveBeenCalledTimes(1);

        cancel();
    });

    test("waits for window.ttq and fires exactly once", () => {
        jest.useFakeTimers();

        setWindow({});

        const callback = jest.fn();
        const cancel = whenTikTokPixelReady(
            callback,
            { pollMs: 50, timeoutMs: 5000 }
        );

        expect(callback).not.toHaveBeenCalled();

        jest.advanceTimersByTime(200);

        expect(callback).not.toHaveBeenCalled();

        /* The base code finally registers. */
        setWindow({ ttq: { track: jest.fn() } });

        jest.advanceTimersByTime(60);

        expect(callback).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(1000);

        expect(callback).toHaveBeenCalledTimes(1);

        cancel();
    });

    test("the pixel-ready event also triggers it", () => {
        setWindow({});

        const callback = jest.fn();
        const cancel = whenTikTokPixelReady(
            callback,
            { pollMs: 60000, timeoutMs: 60000 }
        );

        (
            (globalThis as { window?: unknown })
                .window as {
                dispatchEvent: (event: {
                    type: string;
                }) => boolean;
            }
        ).dispatchEvent({
            type: "tiktok-pixel-ready",
        });

        expect(callback).toHaveBeenCalledTimes(1);

        cancel();
    });

    test("gives up after the timeout without firing", () => {
        jest.useFakeTimers();

        setWindow({});

        const callback = jest.fn();

        whenTikTokPixelReady(callback, {
            pollMs: 50,
            timeoutMs: 200,
        });

        jest.advanceTimersByTime(5000);

        expect(callback).not.toHaveBeenCalled();
    });

    test("cancel prevents a late fire", () => {
        jest.useFakeTimers();

        setWindow({});

        const callback = jest.fn();
        const cancel = whenTikTokPixelReady(
            callback,
            { pollMs: 50, timeoutMs: 5000 }
        );

        cancel();

        setWindow({ ttq: { track: jest.fn() } });

        jest.advanceTimersByTime(1000);

        expect(callback).not.toHaveBeenCalled();
    });

    test("is a no-op without a window", () => {
        delete (globalThis as { window?: unknown })
            .window;

        const callback = jest.fn();

        const cancel = whenTikTokPixelReady(callback);

        expect(callback).not.toHaveBeenCalled();

        expect(() => cancel()).not.toThrow();
    });

    test("ViewContent waits for identity + the pixel, Advanced Matching for the pixel", () => {
        /*
         * Phase 22: event components wait via the identity-aware
         * helper (which itself waits for the Pixel), while the
         * Advanced Matching component registers identity directly
         * once the Pixel is ready.
         */
        expect(
            readFile(
                "components/products/ProductDetail.tsx"
            )
        ).toContain("whenTikTokReadyForEvents(");

        expect(
            readFile(
                "components/analytics/TikTokAdvancedMatching.tsx"
            )
        ).toContain("whenTikTokPixelReady(");
    });
});

/* ==========================================
 * G. SECURITY / REGRESSION ASSERTIONS
 * ========================================== */

describe("TikTok Advanced Matching — security invariants", () => {
    test("the matching helper is server-only", () => {
        expect(
            readFile(
                "lib/analytics/tiktok-user-match.ts"
            )
        ).toMatch(/^\s*import\s+"server-only";/m);
    });

    test("the client component consumes the endpoint payload and never hashes locally", () => {
        const code = readFile(
            "components/analytics/TikTokAdvancedMatching.tsx"
        );

        expect(code).toContain(
            "/api/analytics/tiktok-match"
        );
        expect(code).toContain(
            "trackTikTokUserMatch"
        );

        /* No direct pixel call, no local hashing, no PII storage. */
        expect(code).not.toContain("ttq.identify(");
        expect(code).not.toContain("subtle");
        expect(code).not.toContain("localStorage");
    });

    test("the event storefront callers never call ttq.identify directly", () => {
        for (const file of [
            "components/products/ProductDetail.tsx",
            "app/checkout/CheckoutPage.tsx",
            "app/buy-now/BuyNowPage.tsx",
            "components/analytics/PurchaseTracker.tsx",
        ]) {
            expect(readFile(file)).not.toContain(
                "ttq.identify("
            );
        }
    });

    test("no raw PII is ever logged by the events API module", () => {
        const code = readFile(
            "lib/analytics/tiktok-events-api.ts"
        );

        expect(code).not.toContain("console.log(");
        expect(code).toContain(
            "Access-Token"
        );
        /* The token only ever appears as the header name. */
        expect(code).not.toContain(
            "console.error(\n                TOKEN"
        );
    });

    test("webhooks select only email/phone and pass them hashed", () => {
        for (const file of [
            "app/api/payment/midtrans/notification/route.ts",
            "app/api/payment/ipaymu/notification/route.ts",
        ]) {
            const code = readFile(file);

            expect(code).toContain("email: true");
            expect(code).toContain("phone: true");
            expect(code).not.toContain(
                "include: { user: true }"
            );
            expect(code).toContain(
                "userId: existingOrder.userId"
            );
            expect(code).not.toContain("test_event_code");

            /* Never log the identity fields we just selected. */
            expect(code).not.toMatch(
                /console\.[a-z]+\([^)]*(email|phone)/i
            );
        }
    });

    test("browser CompletePayment callers keep the shared event id", () => {
        for (const file of [
            "app/checkout/payment/[id]/page.tsx",
            "app/checkout/payment-finish/payment-finish-content.tsx",
            "components/analytics/PurchaseTracker.tsx",
        ]) {
            const code = readFile(file);

            expect(code).toContain(
                "buildTikTokEventId("
            );
            expect(code).toContain(
                "\"CompletePayment\""
            );
        }
    });

    test("the matching route never exposes pixel/secret columns", () => {
        const code = readFile(
            "app/api/analytics/tiktok-match/route.ts"
        );

        expect(code).not.toContain("AccessToken");
        expect(code).not.toContain(
            "accessToken"
        );
        expect(code).not.toContain("password");
        expect(code).not.toContain("tiktokPixel");
    });
});
