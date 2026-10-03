/**
 * ==========================================
 * TIKTOK PURCHASE IDENTITY (AUTHORITATIVE ORDER → USER)
 * ==========================================
 *
 * Regression suite for the Events Manager diagnostic:
 *
 *   "Email dan nomor telepon tidak ada" — Critical, affected
 *   event: Purchase, connection: Browser, on
 *   `/checkout/success?order=...`.
 *
 * Root cause proven here:
 *   The browser CompletePayment (PurchaseTracker on
 *   /checkout/success) relied ONLY on the session-driven identity
 *   store. On a post-redirect confirmation page that store could
 *   settle as ANONYMOUS (session / matching-lookup timing, or an
 *   exhausted `ttq.identify` retry budget), so Purchase reached
 *   TikTok with neither `email` nor `phone_number` even though the
 *   order's user had both.
 *
 * Fix asserted here:
 *   the server reads Order → User (email / phone) + userId, hashes
 *   with the SAME helpers as the server Events API, and hands the
 *   SHA-256 digests to the browser Purchase, which calls
 *   `ttq.identify()` with them immediately before `ttq.track()`.
 *
 * The tests intercept the EXACT payload handed to
 * `ttq.identify(...)`, `ttq.track(...)` and the Events API body —
 * not just helper return values. No test contacts TikTok; fetch is
 * mocked and no raw PII is ever placed in a fixture expectation.
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
    buildTikTokEventId,
} from "@/lib/analytics/tiktok";

import {
    buildTikTokBrowserMatch,
    hashTikTokMatchEmail,
    hashTikTokMatchExternalId,
    hashTikTokMatchPhone,
    sha256TikTokMatch,
} from "@/lib/analytics/tiktok-user-match";

import {
    trackTikTokServerCompletePayment,
} from "@/lib/analytics/tiktok-events-api";

import {
    trackAuthoritativeTikTokPurchase,
} from "@/components/analytics/PurchaseTracker";

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

/**
 * Source with every block/line comment removed, so source-scan
 * assertions inspect CODE and not prose that merely documents the
 * contract.
 */
function readCode(relativePath: string): string {
    return readFile(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

/* ==========================================
 * FIXTURES — raw input only inside this file
 * ========================================== */

const PIXEL_ID = "C1A2B3C4D5E6F7G8H9J0";
const TOKEN = "act.example-access-token-0000wxyz";

const RAW_EMAIL = "buyer@example.com";
const RAW_PHONE = "08123456789";
const USER_ID = "user_abc123";

const ORDER_NUMBER = "PAY-CART-900";

/** sha256 normalized email/phone/external_id — asserted, never sent. */
const EMAIL_HASH = hashTikTokMatchEmail(RAW_EMAIL) as string;
const PHONE_HASH = hashTikTokMatchPhone(RAW_PHONE) as string;
const EXTERNAL_ID_HASH = hashTikTokMatchExternalId(
    USER_ID
) as string;

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

type IdentifyCall = Record<string, unknown>;
type TrackCall = {
    event: string;
    properties?: Record<string, unknown>;
    options?: { event_id?: string };
};

type FakePixel = {
    identifies: IdentifyCall[];
    tracks: TrackCall[];
};

/**
 * Install a fake `window.ttq` that records the EXACT arguments the
 * application hands to `ttq.identify()` and `ttq.track()`.
 */
function installPixel(): FakePixel {
    const pixel: FakePixel = {
        identifies: [],
        tracks: [],
    };

    (globalThis as { window?: unknown }).window = {
        ttq: {
            identify: (identifiers: IdentifyCall) => {
                pixel.identifies.push({
                    ...identifiers,
                });
            },
            track: (
                event: string,
                properties?: Record<string, unknown>,
                options?: { event_id?: string }
            ) => {
                pixel.tracks.push({
                    event,
                    properties,
                    options,
                });
            },
        },
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    };

    return pixel;
}

beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockReset();
    delete process.env.TIKTOK_TEST_EVENT_CODE;
    delete (globalThis as { window?: unknown }).window;
});

afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
});

/* ==========================================
 * 1–4. BROWSER PURCHASE PAYLOAD
 * ========================================== */

describe("browser Purchase carries authoritative identity", () => {
    test("1. authenticated user with email + phone + external_id", () => {
        const pixel = installPixel();

        const identity = buildTikTokBrowserMatch({
            email: RAW_EMAIL,
            phone: RAW_PHONE,
            externalId: USER_ID,
        });

        trackAuthoritativeTikTokPurchase({
            orderId: ORDER_NUMBER,
            total: 75000,
            items: [],
            identity,
        });

        /* identify first, with EXACTLY the three digests. */
        expect(pixel.identifies).toHaveLength(1);
        expect(pixel.identifies[0]).toEqual({
            email: EMAIL_HASH,
            phone_number: PHONE_HASH,
            external_id: EXTERNAL_ID_HASH,
        });

        for (const value of Object.values(
            pixel.identifies[0]
        )) {
            expect(value).toMatch(/^[a-f0-9]{64}$/);
        }

        expect(pixel.tracks).toHaveLength(1);
        expect(pixel.tracks[0].event).toBe(
            "CompletePayment"
        );
    });

    test("2. email-only user omits phone_number entirely", () => {
        const pixel = installPixel();

        const identity = buildTikTokBrowserMatch({
            email: RAW_EMAIL,
            externalId: USER_ID,
        });

        trackAuthoritativeTikTokPurchase({
            orderId: ORDER_NUMBER,
            total: 10000,
            identity,
        });

        expect(pixel.identifies[0]).toEqual({
            email: EMAIL_HASH,
            external_id: EXTERNAL_ID_HASH,
        });
        expect(pixel.identifies[0]).not.toHaveProperty(
            "phone_number"
        );
    });

    test("3. phone-only user omits email entirely", () => {
        const pixel = installPixel();

        const identity = buildTikTokBrowserMatch({
            phone: RAW_PHONE,
            externalId: USER_ID,
        });

        trackAuthoritativeTikTokPurchase({
            orderId: ORDER_NUMBER,
            total: 10000,
            identity,
        });

        expect(pixel.identifies[0]).toEqual({
            phone_number: PHONE_HASH,
            external_id: EXTERNAL_ID_HASH,
        });
        expect(pixel.identifies[0]).not.toHaveProperty(
            "email"
        );
    });

    test("4. guest / no identity → no identify call, event still fires", () => {
        const pixel = installPixel();

        trackAuthoritativeTikTokPurchase({
            orderId: ORDER_NUMBER,
            total: 10000,
            identity: null,
        });

        expect(pixel.identifies).toHaveLength(0);
        expect(pixel.tracks).toHaveLength(1);
        expect(pixel.tracks[0].event).toBe(
            "CompletePayment"
        );
    });

    test("4b. an empty identity object never fabricates keys", () => {
        const pixel = installPixel();

        trackAuthoritativeTikTokPurchase({
            orderId: ORDER_NUMBER,
            total: 10000,
            identity: {},
        });

        expect(pixel.identifies).toHaveLength(0);
        expect(pixel.tracks).toHaveLength(1);
    });

    test("9. a correct digest is forwarded unchanged (no double hash)", () => {
        const pixel = installPixel();

        const identity = buildTikTokBrowserMatch({
            email: RAW_EMAIL,
            phone: RAW_PHONE,
            externalId: USER_ID,
        });

        trackAuthoritativeTikTokPurchase({
            orderId: ORDER_NUMBER,
            total: 10000,
            identity,
        });

        /* Byte-for-byte identical — the Pixel digests are the ones
         * the server Events API also sends. */
        expect(pixel.identifies[0].email).toBe(EMAIL_HASH);
        expect(pixel.identifies[0].phone_number).toBe(
            PHONE_HASH
        );
        expect(pixel.identifies[0].external_id).toBe(
            EXTERNAL_ID_HASH
        );

        /* Proof that hashing again WOULD corrupt the value. */
        expect(sha256TikTokMatch(EMAIL_HASH)).not.toBe(
            EMAIL_HASH
        );
        expect(sha256TikTokMatch(PHONE_HASH)).not.toBe(
            PHONE_HASH
        );
    });

    test("raw email / phone never reach ttq.identify or ttq.track", () => {
        const pixel = installPixel();

        trackAuthoritativeTikTokPurchase({
            orderId: ORDER_NUMBER,
            total: 10000,
            identity: buildTikTokBrowserMatch({
                email: RAW_EMAIL,
                phone: RAW_PHONE,
                externalId: USER_ID,
            }),
        });

        const serialized = JSON.stringify(pixel);

        expect(serialized).not.toContain(RAW_EMAIL);
        expect(serialized).not.toContain(RAW_PHONE);
        expect(serialized).not.toContain("+628123456789");
        expect(serialized).not.toContain(USER_ID);
    });
});

/* ==========================================
 * 10. BROWSER / SERVER EVENT_ID DEDUP
 * ========================================== */

describe("CompletePayment deduplication is preserved", () => {
    test("10. browser and server use the identical event_id", async () => {
        const pixel = installPixel();

        trackAuthoritativeTikTokPurchase({
            orderId: ORDER_NUMBER,
            total: 75000,
            identity: null,
        });

        const browserEventId =
            pixel.tracks[0].options?.event_id;

        expect(browserEventId).toBe(
            buildTikTokEventId(
                "CompletePayment",
                ORDER_NUMBER
            )
        );

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

        await trackTikTokServerCompletePayment({
            orderNumber: ORDER_NUMBER,
            total: 75000,
            items: [],
            email: RAW_EMAIL,
            phone: RAW_PHONE,
            userId: USER_ID,
        });

        const serverBody = JSON.parse(
            fetchMock.mock.calls[0][1].body
        );

        expect(browserEventId).toBe("ttq:completepayment:" + ORDER_NUMBER);
        expect(serverBody.data[0].event_id).toBe(
            browserEventId
        );
        expect(serverBody.data[0].event).toBe(
            "CompletePayment"
        );
    });
});

/* ==========================================
 * 6–8. SERVER EVENTS API CONDITIONAL FIELDS
 * ========================================== */

describe("server CompletePayment sends only available identifiers", () => {
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

    async function serverUser(
        overrides: Partial<{
            email: string | null;
            phone: string | null;
            userId: string | null;
        }>
    ): Promise<Record<string, unknown>> {
        await trackTikTokServerCompletePayment({
            orderNumber: ORDER_NUMBER,
            total: 75000,
            items: [],
            email: null,
            phone: null,
            userId: null,
            ...overrides,
        });

        const body = JSON.parse(
            fetchMock.mock.calls[0][1].body
        );

        return body.data[0].user;
    }

    test("6. email + phone + external_id → all three", async () => {
        const user = await serverUser({
            email: RAW_EMAIL,
            phone: RAW_PHONE,
            userId: USER_ID,
        });

        expect(user).toEqual({
            email: EMAIL_HASH,
            phone: PHONE_HASH,
            external_id: EXTERNAL_ID_HASH,
        });
    });

    test("7. email-only → phone omitted, never empty", async () => {
        const user = await serverUser({
            email: RAW_EMAIL,
            userId: USER_ID,
        });

        expect(user).toEqual({
            email: EMAIL_HASH,
            external_id: EXTERNAL_ID_HASH,
        });
        expect(user).not.toHaveProperty("phone");
    });

    test("8. phone-only → email omitted, never empty", async () => {
        const user = await serverUser({
            phone: RAW_PHONE,
            userId: USER_ID,
        });

        expect(user).toEqual({
            phone: PHONE_HASH,
            external_id: EXTERNAL_ID_HASH,
        });
        expect(user).not.toHaveProperty("email");
    });

    test("an order with no identifiers omits the user object", async () => {
        await trackTikTokServerCompletePayment({
            orderNumber: ORDER_NUMBER,
            total: 10000,
            items: [],
            email: null,
            phone: null,
            userId: null,
        });

        const body = JSON.parse(
            fetchMock.mock.calls[0][1].body
        );

        expect(body.data[0]).not.toHaveProperty("user");
    });
});

/* ==========================================
 * 11. NO RAW PII IN LOGS
 * ========================================== */

describe("server CompletePayment never logs raw PII", () => {
    test("11. raw email / phone / id never appear in any log call", async () => {
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

        const log = jest
            .spyOn(console, "log")
            .mockImplementation(() => {});
        const warn = jest
            .spyOn(console, "warn")
            .mockImplementation(() => {});
        const error = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        await trackTikTokServerCompletePayment({
            orderNumber: ORDER_NUMBER,
            total: 75000,
            items: [],
            email: RAW_EMAIL,
            phone: RAW_PHONE,
            userId: USER_ID,
        });

        const logged = JSON.stringify([
            log.mock.calls,
            warn.mock.calls,
            error.mock.calls,
        ]);

        expect(logged).not.toContain(RAW_EMAIL);
        expect(logged).not.toContain(RAW_PHONE);
        expect(logged).not.toContain("+628123456789");
        expect(logged).not.toContain(USER_ID);
        expect(logged).not.toContain(TOKEN);

        log.mockRestore();
        warn.mockRestore();
        error.mockRestore();
    });
});

/* ==========================================
 * 5. /checkout/success WIRING + SOURCE GUARDS
 * ========================================== */

describe("checkout success uses authoritative Order → User identity", () => {
    const page = readCode(
        "app/checkout/success/page.tsx"
    );
    const tracker = readCode(
        "components/analytics/PurchaseTracker.tsx"
    );

    test("5. the page reads order.user email/phone, not client input", () => {
        /* Include the user relation (email/phone) on the order. */
        expect(page).toContain("user: {");
        expect(page).toContain("email: true");
        expect(page).toContain("phone: true");

        /* Identity is built from the ORDER and userId. */
        expect(page).toContain("buildTikTokBrowserMatch");
        expect(page).toContain("order.user?.email");
        expect(page).toContain(
            "order.user?.phone ?? order.phone"
        );
        expect(page).toContain("externalId: order.userId");

        /* And passed to the browser tracker. */
        expect(page).toContain("identity={tiktokIdentity}");
    });

    test("the page never trusts identity from the query string", () => {
        expect(page).not.toContain(
            'searchParams.get("email")'
        );
        expect(page).not.toContain(
            'searchParams.get("phone")'
        );
    });

    test("PurchaseTracker identifies with digests before the event", () => {
        expect(tracker).toContain("trackTikTokUserMatch");
        expect(tracker).toContain(
            "trackAuthoritativeTikTokPurchase"
        );
        expect(tracker).toContain(
            "whenTikTokReadyForEvents"
        );

        /* identify() must precede the track() call. */
        const identifyAt = tracker.indexOf(
            "trackTikTokUserMatch("
        );
        const trackAt = tracker.indexOf(
            'trackTikTokEvent('
        );

        expect(identifyAt).toBeGreaterThan(-1);
        expect(trackAt).toBeGreaterThan(-1);
        expect(identifyAt).toBeLessThan(trackAt);
    });

    test("the client bundle never receives a raw or secret value", () => {
        for (const source of [page, tracker]) {
            expect(source).not.toContain("MENGANTAR");
            expect(source).not.toContain(
                "TIKTOK_ACCESS_TOKEN"
            );
            expect(source).not.toContain("tiktokPixelAccessToken");
            expect(source).not.toContain("CRON_SECRET");
        }

        /* The tracker must not construct raw identity itself. */
        expect(tracker).not.toContain(
            "normalizeTikTokMatchEmail"
        );
        expect(tracker).not.toContain(
            "hashTikTokMatchEmail"
        );
    });

    test("the identity helper is the server-only, non-double-hash one", () => {
        const userMatch = readFile(
            "lib/analytics/tiktok-user-match.ts"
        );

        /* The browser-facing builder hashes exactly once. */
        expect(userMatch).toContain(
            "export function buildTikTokBrowserMatch"
        );
        expect(userMatch).toContain('import "server-only"');
    });
});
