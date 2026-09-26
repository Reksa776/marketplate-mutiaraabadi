/**
 * ==========================================
 * PHASE 22 — TIKTOK SIGNAL QUALITY HARDENING
 * ==========================================
 *
 * Covers the confirmed gaps from the audit:
 *
 *   1. browser identity readiness / ordering
 *   2. browser hash semantics (raw to the Pixel, hash to Events API)
 *   3. ttclid / _ttp capture
 *   4. customer IP + user-agent at the application boundary
 *   5. attribution persisted through order creation
 *   6. server CompletePayment forwards stored attribution
 *   7. hashed PII + stable event_id + browser/server dedup preserved
 *   8. anonymous events remain valid
 *
 * No test contacts TikTok production or the database.
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
};

jest.mock("@/lib/prisma", () => ({
    prisma: mockPrisma,
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

import {
    TIKTOK_ATTRIBUTION_COOKIE,
    captureTikTokAttributionFromBrowser,
    mergeTikTokAttribution,
    parseTikTokAttributionCookie,
    readCookieValue,
    readTikTokClickIdFromSearch,
    readTtpFromCookieString,
    sanitizeTikTokAttributionToken,
    sanitizeTikTokAttributionUrl,
    serializeTikTokAttributionCookie,
    type TikTokAttribution,
} from "@/lib/analytics/attribution";

import {
    readOrderAttribution,
    resolveClientIp,
    sanitizeClientUserAgent,
} from "@/lib/analytics/attribution-server";

import {
    buildTikTokBrowserMatch,
    buildTikTokUserMatch,
    hashTikTokMatchEmail,
    normalizeTikTokMatchEmail,
    normalizeTikTokMatchPhone,
    sha256TikTokMatch,
} from "@/lib/analytics/tiktok-user-match";

import {
    getTikTokIdentity,
    isTikTokIdentitySettled,
    resetTikTokIdentityForTests,
    settleTikTokIdentity,
    whenTikTokIdentitySettled,
    whenTikTokReadyForEvents,
} from "@/lib/analytics/tiktok-identity";

import { trackTikTokEvent } from "@/lib/analytics/tiktok";

import {
    TIKTOK_EVENTS_API_URL,
    trackTikTokServerCompletePayment,
} from "@/lib/analytics/tiktok-events-api";

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

const PIXEL_ID = "C1A2B3C4D5E6F7G8H9J0";
const TOKEN = "act.example-access-token-0000wxyz";

type TikTokEventBody = {
    event_source: string;
    event_source_id: string;
    data: Array<{
        event: string;
        event_id: string;
        user: Record<string, unknown>;
        page?: { url?: string };
        properties?: Record<string, unknown>;
    }>;
};

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
    resetTikTokIdentityForTests();
    delete process.env.TRUSTED_PROXY;
});

afterEach(() => {
    jest.useRealTimers();
});

/* ==========================================
 * 1. BROWSER IDENTITY READINESS
 * ========================================== */

describe("TikTok identity readiness", () => {
    function stubWindowWithPixel(): void {
        (globalThis as { window?: unknown }).window = {
            ttq: { track: jest.fn(), identify: jest.fn() },
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
        };
    }

    test("starts unsettled and settles exactly once", () => {
        expect(isTikTokIdentitySettled()).toBe(false);
        expect(getTikTokIdentity()).toBeNull();

        settleTikTokIdentity({ email: "hashed" });

        expect(isTikTokIdentitySettled()).toBe(true);
        expect(getTikTokIdentity()).toEqual({
            email: "hashed",
        });

        /* A second settlement must not overwrite the first. */
        settleTikTokIdentity(null);
        expect(getTikTokIdentity()).toEqual({
            email: "hashed",
        });
    });

    test("authenticated event waits for identity, then fires", () => {
        stubWindowWithPixel();
        const fired: string[] = [];

        whenTikTokReadyForEvents(() =>
            fired.push("event")
        );

        /* Not settled yet: the event must NOT have fired. */
        expect(fired).toEqual([]);

        settleTikTokIdentity({
            external_id: "hashed",
        });

        /* Identity settled → Pixel ready → event fires. */
        expect(fired).toEqual(["event"]);
    });

    test("anonymous visitor is settled and never blocked", () => {
        stubWindowWithPixel();
        const fired: string[] = [];

        whenTikTokReadyForEvents(() =>
            fired.push("event")
        );

        settleTikTokIdentity(null);

        expect(fired).toEqual(["event"]);
        expect(getTikTokIdentity()).toBeNull();
    });

    test("a never-settling identity cannot block an event forever", () => {
        jest.useFakeTimers();
        stubWindowWithPixel();
        const fired: string[] = [];

        whenTikTokReadyForEvents(
            () => fired.push("event"),
            { identityTimeoutMs: 50 }
        );

        jest.advanceTimersByTime(60);

        expect(fired).toEqual(["event"]);
    });

    test("whenTikTokIdentitySettled times out to anonymous", () => {
        jest.useFakeTimers();
        const seen: Array<unknown> = [];

        whenTikTokIdentitySettled(
            (value) => seen.push(value),
            { timeoutMs: 25 }
        );

        jest.advanceTimersByTime(30);
        expect(seen).toEqual([null]);
    });
});

/* ==========================================
 * 2. BROWSER HASH SEMANTICS
 * ========================================== */

describe("Browser Advanced Matching hash semantics", () => {
    test("browser match returns NORMALIZED RAW values (Pixel auto-hashes)", () => {
        expect(
            buildTikTokBrowserMatch({
                email: "  Buyer@Example.COM ",
                phone: "08123456789",
                externalId: "  user_abc123  ",
            })
        ).toEqual({
            email: "buyer@example.com",
            phone_number: "+628123456789",
            external_id: "user_abc123",
        });
    });

    test("server match returns SHA-256 digests (Events API requires hashes)", () => {
        const server = buildTikTokUserMatch({
            email: "buyer@example.com",
            phone: "08123456789",
            externalId: "user_abc123",
        });

        expect(server.email).toBe(
            hashTikTokMatchEmail("buyer@example.com")
        );
        expect(server.email).toMatch(/^[a-f0-9]{64}$/);
        expect(server.phone).toMatch(/^[a-f0-9]{64}$/);
        expect(server.external_id).toMatch(
            /^[a-f0-9]{64}$/
        );
    });

    test("invalid values are omitted, never hashed into placeholders", () => {
        expect(
            buildTikTokBrowserMatch({
                email: "not-an-email",
                phone: "",
                externalId: "   ",
            })
        ).toEqual({});
    });
});

/* ==========================================
 * 3/4/5. NORMALIZATION
 * ========================================== */

describe("Identifier normalization", () => {
    test("email normalization trims and lowercases", () => {
        expect(
            normalizeTikTokMatchEmail(
                "  Buyer@Example.COM "
            )
        ).toBe("buyer@example.com");
    });

    test("phone normalization produces E.164", () => {
        expect(
            normalizeTikTokMatchPhone("08123456789")
        ).toBe("+628123456789");
        expect(
            normalizeTikTokMatchPhone("+62 812-3456-789")
        ).toBe("+628123456789");
        expect(
            normalizeTikTokMatchPhone("not a phone")
        ).toBeNull();
    });

    test("external_id is trimmed before hashing", () => {
        expect(
            buildTikTokUserMatch({
                externalId: "  user_abc123  ",
            }).external_id
        ).toBe(sha256TikTokMatch("user_abc123"));
    });
});

/* ==========================================
 * 3. TTCLID CAPTURE
 * ========================================== */

describe("ttclid capture", () => {
    test("reads ttclid from a landing URL", () => {
        expect(
            readTikTokClickIdFromSearch(
                "?ttclid=abc123&utm_source=tiktok"
            )
        ).toBe("abc123");
        expect(
            readTikTokClickIdFromSearch(
                "ttclid=xyz789"
            )
        ).toBe("xyz789");
    });

    test("returns null when ttclid is absent", () => {
        expect(
            readTikTokClickIdFromSearch("?utm_source=google")
        ).toBeNull();
        expect(readTikTokClickIdFromSearch("")).toBeNull();
    });

    test("persists ttclid + landing into the first-party cookie", () => {
        const documentStub = {
            cookie: "",
        };

        (globalThis as { document?: unknown }).document =
            documentStub;
        (globalThis as { window?: unknown }).window = {
            location: {
                search: "?ttclid=abc123",
                href: "https://shop.test/products/1?ttclid=abc123",
            },
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
        };

        const captured =
            captureTikTokAttributionFromBrowser();

        expect(captured?.ttclid).toBe("abc123");
        expect(captured?.landingUrl).toBe(
            "https://shop.test/products/1?ttclid=abc123"
        );

        /* The cookie now survives navigation. */
        expect(documentStub.cookie).toContain(
            `${TIKTOK_ATTRIBUTION_COOKIE}=`
        );

        const parsed =
            parseTikTokAttributionCookie(
                documentStub.cookie
            );
        expect(parsed?.ttclid).toBe("abc123");

        /* First touch wins: a later navigation must not overwrite. */
        (globalThis as { window: { location: { search: string; href: string } } }).window.location =
            {
                search: "?ttclid=later999",
                href: "https://shop.test/checkout",
            };

        const second =
            captureTikTokAttributionFromBrowser();

        expect(second?.ttclid).toBe("abc123");
        expect(second?.landingUrl).toBe(
            "https://shop.test/products/1?ttclid=abc123"
        );

        delete (globalThis as { document?: unknown })
            .document;
        delete (globalThis as { window?: unknown }).window;
    });
});

/* ==========================================
 * 4. _TTP CAPTURE
 * ========================================== */

describe("_ttp capture", () => {
    test("reads TikTok's own _ttp cookie when present", () => {
        expect(
            readTtpFromCookieString(
                "session=xyz; _ttp=ttp-value-123; other=1"
            )
        ).toBe("ttp-value-123");
    });

    test("returns null when _ttp is absent (never fabricated)", () => {
        expect(
            readTtpFromCookieString("session=xyz")
        ).toBeNull();
        expect(readTtpFromCookieString("")).toBeNull();
    });

    test("a capture with no _ttp stores null", () => {
        const documentStub = { cookie: "" };
        (globalThis as { document?: unknown }).document =
            documentStub;
        (globalThis as { window?: unknown }).window = {
            location: {
                search: "?ttclid=abc",
                href: "https://shop.test/",
            },
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
        };

        const captured =
            captureTikTokAttributionFromBrowser();

        expect(captured?.ttp).toBeNull();

        delete (globalThis as { document?: unknown })
            .document;
        delete (globalThis as { window?: unknown }).window;
    });
});

/* ==========================================
 * COOKIE PARSING / SANITIZATION
 * ========================================== */

describe("Attribution cookie parsing + sanitization", () => {
    test("round-trips a serialized attribution", () => {
        const attribution: TikTokAttribution = {
            ttclid: "abc123",
            ttp: "ttp-1",
            landingUrl: "https://shop.test/",
            referrer: "https://www.tiktok.com/",
            capturedAt: 1700000000000,
        };

        const cookie = `other=1; ${TIKTOK_ATTRIBUTION_COOKIE}=${serializeTikTokAttributionCookie(
            attribution
        )}`;

        expect(
            parseTikTokAttributionCookie(cookie)
        ).toEqual(attribution);
    });

    test("corrupt cookies degrade to null", () => {
        expect(
            parseTikTokAttributionCookie(
                `${TIKTOK_ATTRIBUTION_COOKIE}=not-json`
            )
        ).toBeNull();
        expect(readCookieValue("a=1", "b")).toBeNull();
    });

    test("tokens are trimmed, bounded and control-stripped", () => {
        expect(
            sanitizeTikTokAttributionToken(
                "  a\u0000b  ",
                10
            )
        ).toBe("ab");
        expect(
            sanitizeTikTokAttributionToken(
                "x".repeat(100),
                10
            )?.length
        ).toBe(10);
        expect(
            sanitizeTikTokAttributionToken(null, 10)
        ).toBeNull();
    });

    test("only absolute http(s) URLs are accepted", () => {
        expect(
            sanitizeTikTokAttributionUrl(
                "https://shop.test/"
            )
        ).toBe("https://shop.test/");
        expect(
            sanitizeTikTokAttributionUrl(
                "javascript:alert(1)"
            )
        ).toBeNull();
        expect(
            sanitizeTikTokAttributionUrl("not a url")
        ).toBeNull();
    });

    test("merge keeps the earliest touch and refreshes _ttp", () => {
        const first: TikTokAttribution = {
            ttclid: "abc",
            ttp: "old-ttp",
            landingUrl: "https://shop.test/a",
            referrer: "https://www.tiktok.com/",
            capturedAt: 1,
        };

        const merged = mergeTikTokAttribution(first, {
            ttclid: "later",
            ttp: "new-ttp",
            landingUrl: "https://shop.test/b",
            referrer: null,
            capturedAt: 2,
        });

        expect(merged.ttclid).toBe("abc");
        expect(merged.landingUrl).toBe(
            "https://shop.test/a"
        );
        expect(merged.ttp).toBe("new-ttp");
    });
});

/* ==========================================
 * 5. CUSTOMER IP + USER AGENT
 * ========================================== */

describe("Customer request metadata boundary", () => {
    test("captures the customer IP behind a trusted proxy", () => {
        process.env.TRUSTED_PROXY = "1";

        const request = new Request("https://shop.test/", {
            headers: {
                "x-forwarded-for":
                    "203.0.113.7, 10.0.0.1",
            },
        });

        expect(resolveClientIp(request)).toBe(
            "203.0.113.7"
        );
    });

    test("without a trusted proxy the IP is unknown (null), not spoofable", () => {
        const request = new Request("https://shop.test/", {
            headers: {
                "x-forwarded-for": "203.0.113.7",
            },
        });

        expect(resolveClientIp(request)).toBeNull();
    });

    test("captures and bounds the customer user-agent", () => {
        expect(
            sanitizeClientUserAgent("Mozilla/5.0 Test")
        ).toBe("Mozilla/5.0 Test");
        expect(sanitizeClientUserAgent("")).toBeNull();
        expect(
            sanitizeClientUserAgent(
                "a".repeat(600)
            )?.length
        ).toBe(512);
    });

    test("readOrderAttribution combines cookie + customer metadata", () => {
        process.env.TRUSTED_PROXY = "1";

        const cookie = `${TIKTOK_ATTRIBUTION_COOKIE}=${serializeTikTokAttributionCookie(
            {
                ttclid: "abc123",
                ttp: "ttp-1",
                landingUrl: "https://shop.test/",
                referrer: "https://www.tiktok.com/",
                capturedAt: 1,
            }
        )}`;

        const request = new Request("https://shop.test/", {
            headers: {
                cookie,
                "x-forwarded-for": "203.0.113.7",
                "user-agent": "Mozilla/5.0 Test",
            },
        });

        expect(readOrderAttribution(request)).toEqual({
            ttclid: "abc123",
            ttp: "ttp-1",
            landingUrl: "https://shop.test/",
            referrer: "https://www.tiktok.com/",
            clientIp: "203.0.113.7",
            clientUserAgent: "Mozilla/5.0 Test",
        });

        delete process.env.TRUSTED_PROXY;
    });

    test("missing attribution yields all-null", () => {
        const request = new Request("https://shop.test/");

        expect(readOrderAttribution(request)).toEqual({
            ttclid: null,
            ttp: null,
            landingUrl: null,
            referrer: null,
            clientIp: null,
            clientUserAgent: null,
        });
    });
});

/* ==========================================
 * 11/12. WEBHOOK MUST NOT USE ITS OWN IP/UA
 * ========================================== */

describe("Settlement webhooks never use their own IP / User-Agent", () => {
    for (const file of [
        "app/api/payment/ipaymu/notification/route.ts",
        "app/api/payment/midtrans/notification/route.ts",
    ]) {
        test(`${file} forwards only the STORED customer attribution`, () => {
            const code = readFile(file);

            /* No request-boundary capture helpers in the webhook. */
            expect(code).not.toContain(
                "readOrderAttribution"
            );
            expect(code).not.toContain("getClientIp");
            expect(code).not.toContain(
                "x-forwarded-for"
            );
            expect(code).not.toMatch(
                /headers\.get\(\s*["']user-agent["']/
            );

            /* It forwards what the customer boundary persisted. */
            expect(code).toContain(
                "existingOrder.clientIp"
            );
            expect(code).toContain(
                "existingOrder.clientUserAgent"
            );
            expect(code).toContain("existingOrder.ttclid");
            expect(code).toContain("existingOrder.ttp");
            expect(code).toContain(
                "existingOrder.landingUrl"
            );
        });
    }
});

/* ==========================================
 * 13/14/15. SERVER COMPLETEPAYMENT
 * ========================================== */

describe("Server-side CompletePayment forwards attribution + keeps hashed PII", () => {
    beforeEach(() => {
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            {
                tiktokPixelEnabled: true,
                tiktokPixelId: PIXEL_ID,
                tiktokPixelAccessToken: TOKEN,
            }
        );
        fetchMock.mockResolvedValue(
            jsonResponse({ code: 0 })
        );
    });

    async function send(): Promise<TikTokEventBody> {
        await trackTikTokServerCompletePayment({
            orderNumber: "PAY-CART-0001",
            total: 150000,
            items: [
                {
                    productId: 7,
                    variantId: 3,
                    productName: "Kaos",
                    variantName: "M",
                    quantity: 2,
                    price: 75000,
                },
            ],
            email: "buyer@example.com",
            phone: "08123456789",
            userId: "user_abc123",
            ttclid: "abc123",
            ttp: "ttp-1",
            pageUrl: "https://shop.test/products/1",
            ip: "203.0.113.7",
            userAgent: "Mozilla/5.0 Test",
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0];

        expect(url).toBe(TIKTOK_EVENTS_API_URL);
        expect(init.headers["Access-Token"]).toBe(TOKEN);

        return JSON.parse(init.body) as TikTokEventBody;
    }

    test("event_id + event name are unchanged", async () => {
        const payload = await send();
        const event = payload.data[0];

        expect(payload.event_source).toBe("web");
        expect(payload.event_source_id).toBe(PIXEL_ID);
        expect(event.event).toBe("CompletePayment");
        expect(event.event_id).toBe(
            "ttq:completepayment:PAY-CART-0001"
        );
    });

    test("hashed email / phone / external_id are preserved", async () => {
        const payload = await send();
        const event = payload.data[0];

        expect(event.user.email).toMatch(/^[a-f0-9]{64}$/);
        expect(event.user.phone).toMatch(/^[a-f0-9]{64}$/);
        expect(event.user.external_id).toMatch(
            /^[a-f0-9]{64}$/
        );

        /* Raw PII must never reach TikTok or the body. */
        const body = JSON.stringify(payload);
        expect(body).not.toContain("buyer@example.com");
        expect(body).not.toContain("08123456789");
    });

    test("stored attribution is forwarded (unhashed)", async () => {
        const payload = await send();
        const event = payload.data[0];

        expect(event.user.ttclid).toBe("abc123");
        expect(event.user.ttp).toBe("ttp-1");
        expect(event.user.ip).toBe("203.0.113.7");
        expect(event.user.user_agent).toBe(
            "Mozilla/5.0 Test"
        );
        expect(event.page?.url).toBe(
            "https://shop.test/products/1"
        );
    });

    test("an order without attribution still sends CompletePayment", async () => {
        await trackTikTokServerCompletePayment({
            orderNumber: "PAY-CART-0002",
            total: 50000,
            items: [
                {
                    productId: 1,
                    quantity: 1,
                    price: 50000,
                },
            ],
            email: null,
            phone: "08123456789",
            userId: "user_x",
        });

        const payload = JSON.parse(
            fetchMock.mock.calls[0][1].body
        );
        const event = payload.data[0];

        expect(event.user.ttclid).toBeUndefined();
        expect(event.user.ttp).toBeUndefined();
        expect(event.user.ip).toBeUndefined();
        expect(event.user.user_agent).toBeUndefined();
        expect(event.page).toBeUndefined();
    });
});

/* ==========================================
 * 16. BROWSER/SERVER DEDUP + ANONYMOUS EVENTS
 * ========================================== */

describe("Browser/server dedup + anonymous ViewContent", () => {
    test("the shared event_id builder is unchanged", async () => {
        const { buildTikTokEventId } = await import(
            "@/lib/analytics/tiktok"
        );

        expect(
            buildTikTokEventId(
                "CompletePayment",
                "PAY-CART-0001"
            )
        ).toBe("ttq:completepayment:PAY-CART-0001");
    });

    test("browser CompletePayment callers still share the event id", () => {
        for (const file of [
            "app/checkout/payment/[id]/page.tsx",
            "app/checkout/payment-finish/payment-finish-content.tsx",
            "components/analytics/PurchaseTracker.tsx",
        ]) {
            const code = readFile(file);

            expect(code).toContain("buildTikTokEventId(");
            expect(code).toContain('"CompletePayment"');
            expect(code).toContain(
                "whenTikTokReadyForEvents"
            );
        }
    });

    test("anonymous ViewContent still fires without identity", () => {
        const track = jest.fn();

        (globalThis as { window?: unknown }).window = {
            ttq: {
                track,
                identify: jest.fn(),
            },
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
        };

        trackTikTokEvent("ViewContent", {
            content_id: "7",
            content_type: "product",
        });

        expect(track).toHaveBeenCalledWith(
            "ViewContent",
            {
                content_id: "7",
                content_type: "product",
            }
        );

        delete (globalThis as { window?: unknown }).window;
    });

    test("event components wait for identity via whenTikTokReadyForEvents", () => {
        for (const file of [
            "components/products/ProductDetail.tsx",
            "app/checkout/CheckoutPage.tsx",
            "app/buy-now/BuyNowPage.tsx",
        ]) {
            const code = readFile(file);

            expect(code).toContain(
                "whenTikTokReadyForEvents"
            );
        }
    });
});

/* ==========================================
 * 18. CHECKOUT ATTRIBUTION SURVIVES ORDER CREATION
 * ========================================== */

describe("Attribution survives order creation", () => {
    test("createCheckoutOrder persists every attribution column", () => {
        const code = readFile("lib/checkout.ts");

        expect(code).toContain(
            "input.attribution?.ttclid"
        );
        expect(code).toContain(
            "input.attribution?.ttp"
        );
        expect(code).toContain(
            "?.clientIp"
        );
        expect(code).toContain(
            "?.clientUserAgent"
        );
        expect(code).toContain("?.landingUrl");
        expect(code).toContain("?.referrer");
    });

    test("every order-creation route captures attribution at the boundary", () => {
        for (const file of [
            "app/api/orders/route.ts",
            "app/api/payment/ipaymu/route.ts",
            "app/api/buy-now/route.ts",
            "app/api/buy-now/ipaymu/route.ts",
        ]) {
            const code = readFile(file);

            expect(code).toContain(
                "readOrderAttribution"
            );
            expect(code).toContain(
                "attribution: readOrderAttribution(request)"
            );
        }
    });

    test("the attribution capture component is mounted by the provider", () => {
        const provider = readFile(
            "components/analytics/AnalyticsProvider.tsx"
        );

        expect(provider).toContain("TikTokAttribution");
    });

    test("the browser capture module never imports server-only", () => {
        const code = readFile(
            "lib/analytics/attribution.ts"
        );

        expect(code).not.toContain(
            'import "server-only"'
        );
    });

    test("the attribution server module is server-only", () => {
        expect(
            readFile(
                "lib/analytics/attribution-server.ts"
            )
        ).toMatch(/^\s*import\s+"server-only";/m);
    });
});
