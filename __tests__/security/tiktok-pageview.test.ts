/**
 * ==========================================
 * TIKTOK PAGEVIEW — APPLICATION-CONTROLLED IDENTITY
 * ==========================================
 *
 * Phase 2 coverage for the structural PageView identity gap:
 * the admin base code used to call `ttq.page()` synchronously at
 * Pixel load, before Advanced Matching identity could ever be
 * applied. PageView ownership now moves to the application.
 *
 * A. base code no longer executes ttq.page()
 * B. initial load: PageView waits for whenTikTokReadyForEvents
 * C. authenticated: PageView happens AFTER ttq.identify()
 * D. anonymous: PageView still fires, no fabricated identifiers
 * E. SPA navigation: one PageView per navigation, no duplicate
 * F. security: no raw email/phone, digest-only matching preserved
 * G. existing events keep their identity behaviour
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
    analyzeTikTokPixelCode,
    stripAutomaticTikTokPageView,
} from "@/lib/analytics/tiktok-pixel-code";

import { getTikTokPixelConfig } from "@/lib/analytics/tiktok-config";

import { trackTikTokEvent } from "@/lib/analytics/tiktok";

import { buildTikTokBrowserMatch } from "@/lib/analytics/tiktok-user-match";

import {
    isTikTokIdentitySettled,
    resetTikTokIdentityForTests,
    settleTikTokIdentity,
    whenTikTokReadyForEvents,
} from "@/lib/analytics/tiktok-identity";

import {
    bootstrapTikTokBrowserIdentity,
    resetTikTokBrowserIdentityForTests,
} from "@/lib/analytics/tiktok-browser-identity";

import {
    shouldTrackTikTokPageView,
    tiktokPageViewSignature,
} from "@/lib/analytics/tiktok-pageview";

/* ==========================================
 * FIXTURES + HELPERS
 * ========================================== */

const PIXEL_ID = "C1A2B3C4D5E6F7G8H9J0";
const RAW_EMAIL = "buyer@example.com";
const RAW_PHONE = "08123456789";

/**
 * A realistic copy of the admin base code (as backfilled by the
 * migration): ttq.methods + ttq.load + ttq.page + ready dispatch.
 */
const BASE_CODE = [
    "<script>",
    "!function (w, d, t) {",
    "  w.TiktokAnalyticsObject = t;",
    "  var ttq = w[t] = w[t] || [];",
    '  ttq.methods = ["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];',
    "  ttq.setAndDefer = function (t, e) {",
    "    t[e] = function () {",
    "      t.push([e].concat(Array.prototype.slice.call(arguments, 0)));",
    "    };",
    "  };",
    "  for (var i = 0; i < ttq.methods.length; i++) {",
    "    ttq.setAndDefer(ttq, ttq.methods[i]);",
    "  }",
    "  ttq.load = function (e, n) {",
    '    var r = "https://analytics.tiktok.com/i18n/pixel/events.js";',
    "  };",
    `  ttq.load("${PIXEL_ID}");`,
    "  ttq.page();",
    "  w.dispatchEvent(",
    '    new Event("tiktok-pixel-ready")',
    "  );",
    '}(window, document, "ttq");',
    "</script>",
].join("\n");

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

/** Remove block + line comments so source scans inspect CODE. */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

type BrowserWindow = { window?: unknown };

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as unknown as Response;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

function flush(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
}

/** Records the exact order of identify/track calls. */
function stubPixel(order: string[]): void {
    (globalThis as BrowserWindow).window = {
        ttq: {
            track: (name: string) => {
                order.push(`track:${name}`);
            },
            identify: (identifiers: Record<string, unknown>) => {
                order.push(
                    `identify:${Object.keys(identifiers)
                        .sort()
                        .join(",")}`
                );
            },
        },
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    };
}

function clearWindow(): void {
    delete (globalThis as BrowserWindow).window;
}

beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockReset();
    resetTikTokIdentityForTests();
    resetTikTokBrowserIdentityForTests();
    mockPrisma.storeSetting.findUnique.mockResolvedValue(null);
});

afterEach(() => {
    clearWindow();
});

/* ==========================================
 * A. BASE CODE
 * ========================================== */

describe("TikTok PageView — base code", () => {
    test("stripAutomaticTikTokPageView removes only ttq.page()", () => {
        const stripped =
            stripAutomaticTikTokPageView(BASE_CODE);

        expect(stripped).not.toContain("ttq.page(");
        // Pixel initialization + ready dispatch survive.
        expect(stripped).toContain(
            `ttq.load("${PIXEL_ID}")`
        );
        expect(stripped).toContain(
            "tiktok-pixel-ready"
        );
        // The methods array (contains the string "page") is untouched.
        expect(stripped).toContain(
            'ttq.methods = ["page","track"'
        );
    });

    test("handles spaced / unsemicoloned invocations", () => {
        expect(
            stripAutomaticTikTokPageView(
                "ttq.load('A');\nttq.page ( )\nvar x = 1;"
            )
        ).not.toContain("ttq.page");
    });

    test("leaves code without ttq.page untouched", () => {
        const code = "ttq.load('A');";
        expect(stripAutomaticTikTokPageView(code)).toBe(
            code
        );
    });

    test("the analysis still REPORTS hasPageCall (metadata, not execution)", () => {
        const analysis = analyzeTikTokPixelCode(BASE_CODE);
        expect(analysis.hasPageCall).toBe(true);
        // The stored code is not rewritten by analysis.
        expect(analysis.script).toContain("ttq.page();");
    });

    test("getTikTokPixelConfig returns an executable script WITHOUT ttq.page", async () => {
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            {
                tiktokPixelEnabled: true,
                tiktokPixelId: PIXEL_ID,
                tiktokPixelName: "Web Tiktok",
                tiktokPixelCode: BASE_CODE,
            }
        );

        const config = await getTikTokPixelConfig();

        expect(config.enabled).toBe(true);
        expect(config.script).not.toContain("ttq.page(");
        expect(config.script).toContain(
            `ttq.load("${PIXEL_ID}")`
        );
        expect(config.script).toContain(
            "tiktok-pixel-ready"
        );
        expect(config.script).not.toContain("<script>");
    });
});

/* ==========================================
 * B. INITIAL LOAD — WAITS FOR IDENTITY
 * ========================================== */

describe("TikTok PageView — initial load", () => {
    test("does not fire while identity is pending, fires once after settle", () => {
        const order: string[] = [];
        stubPixel(order);

        /*
         * Mirrors the tracker: PageView registers through the SAME
         * identity gate.
         */
        const cancel = whenTikTokReadyForEvents(() => {
            trackTikTokEvent("PageView");
        });

        expect(order).toEqual([]);
        expect(isTikTokIdentitySettled()).toBe(false);

        settleTikTokIdentity(null);

        expect(order).toEqual(["track:PageView"]);
        cancel();
    });

    test("authenticated identity applies identify BEFORE PageView", async () => {
        const order: string[] = [];
        stubPixel(order);

        fetchMock.mockResolvedValue(
            jsonResponse({
                success: true,
                data: buildTikTokBrowserMatch({
                    email: RAW_EMAIL,
                    phone: RAW_PHONE,
                    externalId: "user_abc123",
                }),
            })
        );

        /* Pixel is already ready — worst case for ordering. */
        bootstrapTikTokBrowserIdentity();

        const cancel = whenTikTokReadyForEvents(() => {
            trackTikTokEvent("PageView");
        });

        await flush();
        await flush();

        expect(order[0]).toBe(
            "identify:email,external_id,phone_number"
        );
        expect(order[1]).toBe("track:PageView");
        expect(isTikTokIdentitySettled()).toBe(true);

        cancel();
    });
});

/* ==========================================
 * C. EMAIL-ONLY / PHONE-ONLY
 * ========================================== */

describe("TikTok PageView — partial identifiers", () => {
    async function identifyKeysFor(
        data: Record<string, unknown>
    ): Promise<string[]> {
        const order: string[] = [];
        stubPixel(order);
        fetchMock.mockResolvedValue(
            jsonResponse({ success: true, data })
        );

        bootstrapTikTokBrowserIdentity();
        await flush();
        await flush();

        return order;
    }

    test("email-only user identifies with email (+external_id), no phone", async () => {
        const order = await identifyKeysFor(
            buildTikTokBrowserMatch({
                email: RAW_EMAIL,
                externalId: "user_abc123",
            })
        );

        expect(order[0]).toBe(
            "identify:email,external_id"
        );
        expect(order.join(",")).not.toContain("phone_number");
    });

    test("phone-only user identifies with phone_number (+external_id), no email", async () => {
        const order = await identifyKeysFor(
            buildTikTokBrowserMatch({
                phone: RAW_PHONE,
                externalId: "user_abc123",
            })
        );

        expect(order[0]).toBe(
            "identify:external_id,phone_number"
        );
        expect(order[0]).not.toContain("email");
    });
});

/* ==========================================
 * D. ANONYMOUS
 * ========================================== */

describe("TikTok PageView — anonymous visitor", () => {
    test("still fires, with no identity and no fabricated keys", () => {
        const track = jest.fn();
        const identify = jest.fn();

        (globalThis as BrowserWindow).window = {
            ttq: { track, identify },
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
        };

        settleTikTokIdentity(null);

        whenTikTokReadyForEvents(() => {
            trackTikTokEvent("PageView");
        });

        expect(track).toHaveBeenCalledTimes(1);
        // Exactly "PageView", no properties, no event_id.
        expect(track.mock.calls[0][0]).toBe("PageView");
        expect(track.mock.calls[0][1]).toBeUndefined();
        // Anonymous never registers identifiers.
        expect(identify).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * E. SPA NAVIGATION / NO DUPLICATE
 * ========================================== */

describe("TikTok PageView — navigation rule", () => {
    test("initial navigation fires", () => {
        expect(
            shouldTrackTikTokPageView({
                enabled: true,
                pathname: "/products/kaos",
                signature: "/products/kaos",
                lastFiredSignature: null,
            })
        ).toBe(true);
    });

    test("same navigation never duplicates (Strict Mode / re-render)", () => {
        expect(
            shouldTrackTikTokPageView({
                enabled: true,
                pathname: "/products/kaos",
                signature: "/products/kaos",
                lastFiredSignature: "/products/kaos",
            })
        ).toBe(false);
    });

    test("a pathname change fires again", () => {
        expect(
            shouldTrackTikTokPageView({
                enabled: true,
                pathname: "/checkout",
                signature: "/checkout",
                lastFiredSignature: "/products/kaos",
            })
        ).toBe(true);
    });

    test("a search-only change is its own navigation", () => {
        const a = tiktokPageViewSignature(
            "/products",
            "page=1"
        );
        const b = tiktokPageViewSignature(
            "/products",
            "page=2"
        );

        expect(a).not.toBe(b);
        expect(
            shouldTrackTikTokPageView({
                enabled: true,
                pathname: "/products",
                signature: b,
                lastFiredSignature: a,
            })
        ).toBe(true);
    });

    test("admin routes and disabled pixel never fire", () => {
        expect(
            shouldTrackTikTokPageView({
                enabled: true,
                pathname: "/admin/orders",
                signature: "/admin/orders",
                lastFiredSignature: null,
            })
        ).toBe(false);

        expect(
            shouldTrackTikTokPageView({
                enabled: false,
                pathname: "/",
                signature: "/",
                lastFiredSignature: null,
            })
        ).toBe(false);
    });

    test("two identical registrations produce only one PageView", () => {
        const order: string[] = [];
        stubPixel(order);
        settleTikTokIdentity(null);

        let lastFired: string | null = null;
        const signature = "/";

        const fire = () =>
            whenTikTokReadyForEvents(() => {
                if (
                    shouldTrackTikTokPageView({
                        enabled: true,
                        pathname: "/",
                        signature,
                        lastFiredSignature: lastFired,
                    })
                ) {
                    lastFired = signature;
                    trackTikTokEvent("PageView");
                }
            });

        const cancelA = fire();
        const cancelB = fire();

        expect(order).toEqual(["track:PageView"]);

        cancelA();
        cancelB();
    });
});

/* ==========================================
 * F. SECURITY
 * ========================================== */

describe("TikTok PageView — security", () => {
    test("the tracker never sends identifiers or event_id", () => {
        const code = stripComments(
            readFile(
                "components/analytics/TikTokPageViewTracker.tsx"
            )
        );

        expect(code).toContain("whenTikTokReadyForEvents");
        expect(code).toContain(
            'trackTikTokEvent("PageView")'
        );
        expect(code).toContain("usePathname");
        expect(code).toContain("useSearchParams");
        // No identifiers, no dedup id, no endpoint call.
        expect(code).not.toContain("event_id");
        expect(code).not.toContain("buildTikTokBrowserMatch");
        expect(code).not.toContain("phone_number");
        expect(code).not.toContain(".email");
        expect(code).not.toContain(".phone");
        expect(code).not.toContain(
            "api/analytics/tiktok-match"
        );
        expect(code).not.toContain("NEXT_PUBLIC");
    });

    test("PageView payload carries no raw PII", () => {
        const track = jest.fn();
        (globalThis as BrowserWindow).window = {
            ttq: { track },
        };

        trackTikTokEvent("PageView");

        const serialized = JSON.stringify(
            track.mock.calls
        );

        expect(serialized).not.toContain(RAW_EMAIL);
        expect(serialized).not.toContain(RAW_PHONE);
        expect(serialized).not.toContain("@");
    });

    test("digest-only browser matching is preserved (no regression)", () => {
        const match = buildTikTokBrowserMatch({
            email: RAW_EMAIL,
            phone: RAW_PHONE,
            externalId: "user_abc123",
        });

        expect(match.email).toMatch(/^[a-f0-9]{64}$/);
        expect(match.phone_number).toMatch(
            /^[a-f0-9]{64}$/
        );
        expect(match.external_id).toMatch(
            /^[a-f0-9]{64}$/
        );
        expect(JSON.stringify(match)).not.toContain(
            RAW_EMAIL
        );
    });
});

/* ==========================================
 * G. EXISTING EVENTS UNAFFECTED
 * ========================================== */

describe("TikTok PageView — existing events keep identity behaviour", () => {
    test.each([
        [
            "components/products/ProductDetail.tsx",
            ["ViewContent", "AddToCart"],
        ],
        [
            "app/checkout/CheckoutPage.tsx",
            ["InitiateCheckout", "AddPaymentInfo"],
        ],
        [
            "app/buy-now/BuyNowPage.tsx",
            ["InitiateCheckout", "AddPaymentInfo"],
        ],
        [
            "app/checkout/payment/[id]/page.tsx",
            ["CompletePayment"],
        ],
        [
            "app/checkout/payment-finish/payment-finish-content.tsx",
            ["CompletePayment"],
        ],
        [
            "components/analytics/PurchaseTracker.tsx",
            ["CompletePayment"],
        ],
    ])("%s waits for identity and still fires %p", (file, events) => {
        const code = readFile(file);

        expect(code).toContain(
            "whenTikTokReadyForEvents"
        );

        for (const event of events as string[]) {
            expect(code).toContain(`"${event}"`);
        }
    });

    test("the tracker is mounted by the provider", () => {
        const provider = readFile(
            "components/analytics/AnalyticsProvider.tsx"
        );

        expect(provider).toContain(
            "TikTokPageViewTracker"
        );
        expect(provider).toContain("Suspense");
    });
});
