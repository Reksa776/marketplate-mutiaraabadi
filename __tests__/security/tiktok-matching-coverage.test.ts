/**
 * ==========================================
 * TIKTOK MATCHING-KEY COVERAGE (BROWSER + SERVER)
 * ==========================================
 *
 * Regression suite for the Events Manager diagnostic
 * "Email dan nomor telepon tidak ada" (">10% of received events
 * have neither email nor phone").
 *
 * Root cause proven here:
 *   The browser identity store used to be released as ANONYMOUS
 *   the moment the Pixel became ready — which is normally before
 *   the async matching lookup resolves. Every event that waited on
 *   the store (ViewContent, AddToCart, InitiateCheckout,
 *   AddPaymentInfo, browser CompletePayment) therefore fired
 *   WITHOUT matching keys for authenticated customers.
 *
 * The tests below assert the required ordering for every eligible
 * event:
 *
 *     Pixel ready → matching data ready → identify → event
 *
 * and that anonymous visitors still track. No test contacts TikTok
 * or the database, and no test emits raw PII.
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
    buildTikTokProductProperties,
} from "@/lib/analytics/tiktok-catalog";

import {
    buildTikTokBrowserMatch,
    buildTikTokUserMatch,
    hashTikTokMatchEmail,
    hashTikTokMatchExternalId,
    hashTikTokMatchPhone,
} from "@/lib/analytics/tiktok-user-match";

import {
    getTikTokIdentity,
    isTikTokIdentitySettled,
    resetTikTokIdentityForTests,
    settleTikTokIdentity,
    upgradeTikTokIdentity,
    whenTikTokReadyForEvents,
} from "@/lib/analytics/tiktok-identity";

import {
    bootstrapTikTokBrowserIdentity,
    resetTikTokBrowserIdentityForTests,
    toTikTokBrowserIdentifiers,
} from "@/lib/analytics/tiktok-browser-identity";

import {
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

const RAW_EMAIL = "buyer@example.com";
const RAW_PHONE = "08123456789";

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

type BrowserWindow = {
    window?: unknown;
};

/**
 * A Pixel stub that records the exact order of identify/track calls
 * plus whether identity was settled when the event fired.
 */
function stubPixel(
    order: string[],
    settledAtTrack: boolean[]
): void {
    (globalThis as BrowserWindow).window = {
        ttq: {
            track: (name: string) => {
                order.push(`track:${name}`);
                settledAtTrack.push(
                    isTikTokIdentitySettled()
                );
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
    delete process.env.TIKTOK_TEST_EVENT_CODE;
});

afterEach(() => {
    clearWindow();
});

/* ==========================================
 * TESTS 1–5 — BROWSER ORDERING PER EVENT
 * ========================================== */

type EventCase = {
    event: string;
    file: string;
};

const AUTHENTICATED_EVENT_CASES: EventCase[] = [
    {
        event: "ViewContent",
        file: "components/products/ProductDetail.tsx",
    },
    {
        event: "AddToCart",
        file: "components/products/ProductDetail.tsx",
    },
    {
        event: "InitiateCheckout",
        file: "app/checkout/CheckoutPage.tsx",
    },
    {
        event: "AddPaymentInfo",
        file: "app/checkout/CheckoutPage.tsx",
    },
    {
        event: "CompletePayment",
        file: "components/analytics/PurchaseTracker.tsx",
    },
];

const MATCHING_DATA = buildTikTokBrowserMatch({
    email: RAW_EMAIL,
    phone: RAW_PHONE,
    externalId: "user_abc123",
});

/**
 * Run the real browser matching bootstrap against a Pixel that is
 * ALREADY ready (the worst case for ordering), then fire one
 * eligible event and capture the call order.
 */
async function simulateEligibleEvent(eventName: string): Promise<{
    order: string[];
    settledAtTrack: boolean[];
    eventHeldWhilePending: boolean;
    settledWhilePending: boolean;
}> {
    const order: string[] = [];
    const settledAtTrack: boolean[] = [];

    stubPixel(order, settledAtTrack);

    const pending = deferred<Response>();
    fetchMock.mockImplementation(() => pending.promise);

    /* Pixel is ready immediately — the old code settled here. */
    bootstrapTikTokBrowserIdentity();

    /* An eligible event registers while the lookup is in flight. */
    const cancelEvent = whenTikTokReadyForEvents(() => {
        const ttq = (
            globalThis as {
                window?: {
                    ttq?: {
                        track: (v: string) => void;
                    };
                };
            }
        ).window?.ttq;

        ttq?.track(eventName);
    });

    await flush();

    const eventHeldWhilePending = order.length === 0;
    const settledWhilePending =
        isTikTokIdentitySettled();

    /* Matching data finally arrives. */
    pending.resolve(
        jsonResponse({ success: true, data: MATCHING_DATA })
    );

    await flush();
    await flush();

    /* Release the bounded identity timer so jest can exit. */
    cancelEvent();

    return {
        order,
        settledAtTrack,
        eventHeldWhilePending,
        settledWhilePending,
    };
}

describe("Authenticated matching-key coverage — browser ordering", () => {
    test.each(AUTHENTICATED_EVENT_CASES)(
        "TEST — $event waits for matching data before firing",
        async ({ event }) => {
            const result = await simulateEligibleEvent(event);

            /* The event did NOT fire while the lookup was in flight. */
            expect(result.eventHeldWhilePending).toBe(true);
            expect(result.settledWhilePending).toBe(false);

            /* identify happens BEFORE the event. */
            expect(result.order[0]).toBe(
                "identify:email,external_id,phone_number"
            );
            expect(result.order[1]).toBe(`track:${event}`);

            /* Identity was settled when the event fired. */
            expect(result.settledAtTrack).toEqual([true]);
        }
    );

    test.each(AUTHENTICATED_EVENT_CASES)(
        "TEST — $event component uses the identity-aware helper",
        ({ event, file }) => {
            const code = readFile(file);

            expect(code).toContain(
                "whenTikTokReadyForEvents("
            );
            expect(code).toContain(`"${event}"`);
        }
    );

    test("TEST 6 — server CompletePayment carries hashed email + phone", async () => {
        mockPrisma.storeSetting.findUnique.mockResolvedValue({
            tiktokPixelEnabled: true,
            tiktokPixelId: PIXEL_ID,
            tiktokPixelAccessToken: TOKEN,
        });

        fetchMock.mockResolvedValue(jsonResponse({ code: 0 }));

        const result = await trackTikTokServerCompletePayment({
            orderNumber: "PAY-0001",
            total: 50000,
            email: RAW_EMAIL,
            phone: RAW_PHONE,
            userId: "user_abc123",
            items: [
                {
                    productId: 42,
                    productName: "Kaos",
                    quantity: 1,
                    price: 50000,
                },
            ],
        });

        expect(result.ok).toBe(true);

        const body = JSON.parse(
            String(fetchMock.mock.calls[0][1].body)
        ) as {
            data: Array<{
                user: Record<string, unknown>;
                event_id: string;
            }>;
        };

        const user = body.data[0].user;

        /* SHA-256 digests only — never the raw values. */
        expect(user.email).toMatch(/^[a-f0-9]{64}$/);
        expect(user.phone).toMatch(/^[a-f0-9]{64}$/);
        expect(user.external_id).toMatch(/^[a-f0-9]{64}$/);

        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain(RAW_EMAIL);
        expect(serialized).not.toContain(RAW_PHONE);
        expect(serialized).not.toContain("08123456789");
    });
});

/* ==========================================
 * TESTS 7–8 — ANONYMOUS VISITORS STILL TRACK
 * ========================================== */

describe("Anonymous visitors still track", () => {
    test.each(["ViewContent", "AddToCart"])(
        "TEST 7/8 — anonymous %s fires immediately, with no fake keys",
        async (event) => {
            const order: string[] = [];
            const settledAtTrack: boolean[] = [];

            stubPixel(order, settledAtTrack);

            /*
             * Anonymous: the component settles the store as
             * anonymous without ever starting a lookup.
             */
            settleTikTokIdentity(null);

            whenTikTokReadyForEvents(() => {
                (
                    globalThis as {
                        window?: {
                            ttq?: {
                                track: (v: string) => void;
                            };
                        };
                    }
                ).window?.ttq?.track(event);
            });

            expect(order).toEqual([`track:${event}`]);
            expect(fetchMock).not.toHaveBeenCalled();
            expect(isTikTokIdentitySettled()).toBe(true);
        }
    );

    test("an unresolvable lookup still releases events as anonymous", async () => {
        const order: string[] = [];
        stubPixel(order, []);

        /* Endpoint fails → "no matching data", never a blocked event. */
        fetchMock.mockResolvedValue(jsonResponse({}, 500));

        bootstrapTikTokBrowserIdentity();

        const cancelEvent = whenTikTokReadyForEvents(() => {
            (
                globalThis as {
                    window?: {
                        ttq?: { track: (v: string) => void };
                    };
                }
            ).window?.ttq?.track("ViewContent");
        });

        await flush();
        await flush();

        cancelEvent();

        expect(order).toEqual(["track:ViewContent"]);
        expect(isTikTokIdentitySettled()).toBe(true);
    });
});

/* ==========================================
 * TESTS 9–12 — PARTIAL / INVALID IDENTIFIERS
 * ========================================== */

describe("Partial and invalid identifiers", () => {
    test("TEST 9 — email only: phone is omitted", () => {
        expect(
            toTikTokBrowserIdentifiers({
                email: hashTikTokMatchEmail(RAW_EMAIL),
            })
        ).toEqual({
            email: hashTikTokMatchEmail(RAW_EMAIL),
        });
    });

    test("TEST 10 — phone only: email is omitted", () => {
        expect(
            toTikTokBrowserIdentifiers({
                phone_number: hashTikTokMatchPhone(RAW_PHONE),
            })
        ).toEqual({
            phone_number: hashTikTokMatchPhone(RAW_PHONE),
        });
    });

    test("TEST 11 — invalid email is omitted by the endpoint, never hashed", () => {
        /*
         * The endpoint builder is the authoritative filter: the
         * browser helper only maps an already-validated payload.
         */
        expect(
            buildTikTokBrowserMatch({
                email: "not-an-email",
                phone: RAW_PHONE,
            })
        ).toEqual({
            phone_number: hashTikTokMatchPhone(RAW_PHONE),
        });

        expect(
            buildTikTokUserMatch({ email: "not-an-email" })
        ).toEqual({});

        /*
         * A RAW value smuggled into the endpoint response is
         * rejected by the browser mapper instead of being handed
         * to the Pixel.
         */
        expect(
            toTikTokBrowserIdentifiers({ email: RAW_EMAIL })
        ).toBeNull();
        expect(
            toTikTokBrowserIdentifiers({ email: "" })
        ).toBeNull();
        expect(
            toTikTokBrowserIdentifiers({})
        ).toBeNull();
    });

    test("TEST 12 — invalid phone is omitted by the endpoint, never hashed", () => {
        expect(
            buildTikTokBrowserMatch({
                phone: "123",
                email: RAW_EMAIL,
            })
        ).toEqual({
            email: hashTikTokMatchEmail(RAW_EMAIL),
        });

        expect(
            buildTikTokUserMatch({
                phone: "123",
                email: RAW_EMAIL,
            })
        ).not.toHaveProperty("phone");

        expect(
            toTikTokBrowserIdentifiers({
                phone_number: "0812",
            })
        ).toBeNull();
    });
});

/* ==========================================
 * TESTS 13–14 — PRIVACY
 * ========================================== */

describe("Privacy invariants", () => {
    test("TEST 13 — the browser lookup endpoint never returns raw secrets", () => {
        const code = readFile(
            "app/api/analytics/tiktok-match/route.ts"
        )
            /* Scan CODE, not the contract described in comments. */
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^[ \t]*\/\/.*$/gm, "");

        expect(code).not.toContain("password");
        expect(code).not.toContain("accessToken");
        expect(code).not.toContain("tiktokPixel");
        expect(code).toContain(
            "buildTikTokBrowserMatch"
        );

        /*
         * The response is filtered through a digest-only guard, so
         * a raw value can never be serialized even if the builder
         * were ever changed.
         */
        expect(code).toContain("digestOnly");
        expect(code).toContain("isTikTokMatchDigest");
    });

    test("TEST 13 — identify is only ever given SHA-256 digests", () => {
        const order: string[] = [];
        const seen: Record<string, unknown>[] = [];

        (globalThis as BrowserWindow).window = {
            ttq: {
                track: () => {},
                identify: (ids: Record<string, unknown>) => {
                    order.push("identify");
                    seen.push(ids);
                },
            },
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
        };

        fetchMock.mockResolvedValue(
            jsonResponse({ success: true, data: MATCHING_DATA })
        );

        bootstrapTikTokBrowserIdentity();

        return flush()
            .then(flush)
            .then(() => {
                expect(seen).toHaveLength(1);

                for (const payload of seen) {
                    for (const value of Object.values(
                        payload
                    )) {
                        expect(String(value)).toMatch(
                            /^[a-f0-9]{64}$/
                        );
                    }
                }

                /* No raw PII reached the Pixel. */
                const serialized = JSON.stringify(seen);

                expect(serialized).not.toContain(RAW_EMAIL);
                expect(serialized).not.toContain(RAW_PHONE);
                expect(serialized).not.toContain("user_abc123");
            });
    });

    test("TEST 13 — the server events module never logs PII", () => {
        const code = readFile(
            "lib/analytics/tiktok-events-api.ts"
        );

        expect(code).not.toContain("console.log(");
        expect(code).not.toMatch(
            /console\.[a-z]+\([^)]*email/i
        );
        expect(code).not.toMatch(
            /console\.[a-z]+\([^)]*phone/i
        );
    });

    test("TEST 14 — no Access Token reaches any client module", () => {
        for (const file of [
            "lib/analytics/tiktok.ts",
            "lib/analytics/tiktok-browser-identity.ts",
            "components/analytics/TikTokAdvancedMatching.tsx",
            "components/analytics/PurchaseTracker.tsx",
            "components/products/ProductDetail.tsx",
            "app/api/analytics/tiktok-match/route.ts",
        ]) {
            const code = readFile(file);

            expect(code).not.toContain("accessToken");
            expect(code).not.toContain("Access-Token");
            expect(code).not.toContain(
                "business-api.tiktok.com"
            );
        }
    });
});

/* ==========================================
 * LIVENESS + IDENTITY UPGRADE
 * ========================================== */

describe("Identify liveness and identity upgrade", () => {
    test("the browser digests equal the server Events API digests", () => {
        /*
         * THE decisive cross-channel check.
         *
         * TikTok matches a browser event to a server event by the
         * user_data digests it received. If the two channels ever
         * disagreed on a single byte, every event would land in
         * "unmatched" and no amount of correct ordering would help.
         *
         * Only the field NAME differs, because each channel's API
         * documents a different one:
         *   server  Business API   -> `phone`
         *   browser Pixel identify -> `phone_number`
         */
        const serverPayload = buildTikTokUserMatch({
            email: RAW_EMAIL,
            phone: RAW_PHONE,
            externalId: "user_abc123",
        });

        const identifiers = toTikTokBrowserIdentifiers(
            MATCHING_DATA
        );

        expect(identifiers).not.toBeNull();
        expect(identifiers).toEqual({
            email: serverPayload.email,
            phone_number: serverPayload.phone,
            external_id: serverPayload.external_id,
        });

        /* Each channel keeps its own documented key name. */
        expect(serverPayload).toHaveProperty("phone");
        expect(serverPayload).not.toHaveProperty(
            "phone_number"
        );
    });

    test("a Pixel whose identify is not attached yet is retried", async () => {
        const order: string[] = [];

        /*
         * The REAL failure mode. `isTikTokPixelReady()` is
         * `Boolean(window.ttq)`, so it reports ready as soon as the
         * base code creates the `ttq` array — which is true a tick
         * before the Pixel's deferred `identify` method exists.
         * A one-shot readiness callback would lose the identifiers
         * right here.
         */
        const ttq: Record<string, unknown> = {};

        (globalThis as BrowserWindow).window = {
            ttq,
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
        };

        fetchMock.mockResolvedValue(
            jsonResponse({ success: true, data: MATCHING_DATA })
        );

        bootstrapTikTokBrowserIdentity();

        await flush();
        await flush();

        /* Pixel "ready" but cannot accept identify yet. */
        expect(order).toEqual([]);
        expect(isTikTokIdentitySettled()).toBe(false);

        /* The Pixel finishes attaching its methods. */
        ttq.identify = () => {
            order.push("identify");
        };

        for (let i = 0; i < 20; i += 1) {
            await new Promise((r) => setTimeout(r, 50));
        }

        expect(order).toEqual(["identify"]);
        expect(isTikTokIdentitySettled()).toBe(true);
        expect(getTikTokIdentity()).toEqual(MATCHING_DATA);
    });

    test("a visitor who logs in mid-session is upgraded from anonymous", async () => {
        const order: string[] = [];

        (globalThis as BrowserWindow).window = {
            ttq: {
                track: (n: string) => order.push(`track:${n}`),
                identify: () => order.push("identify"),
            },
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
        };

        /* Session resolved as anonymous first. */
        settleTikTokIdentity(null);
        expect(getTikTokIdentity()).toBeNull();

        fetchMock.mockResolvedValue(
            jsonResponse({ success: true, data: MATCHING_DATA })
        );

        bootstrapTikTokBrowserIdentity();

        await flush();
        await flush();

        /*
         * identify still runs, and the store is raised from
         * anonymous so events registered from now on are matched.
         */
        expect(order).toContain("identify");
        expect(getTikTokIdentity()).toEqual(MATCHING_DATA);
    });

    test("identity can never be downgraded back to anonymous", () => {
        const email = hashTikTokMatchEmail(RAW_EMAIL);

        expect(email).not.toBeNull();

        settleTikTokIdentity({ email: email as string });

        upgradeTikTokIdentity(null);

        expect(getTikTokIdentity()).toEqual({
            email: email as string,
        });
    });
});

/* ==========================================
 * TESTS 15–16 — CATALOG + DEDUP REGRESSION
 * ========================================== */

describe("Catalog and dedup regressions", () => {
    test("TEST 15 — content_id mapping is untouched", () => {
        const properties = buildTikTokProductProperties({
            productId: 42,
            productName: "Kaos Polos",
            price: 50000,
        });

        expect(properties.content_id).toBe("42");
        expect(properties.content_type).toBe("product");
        expect(
            (properties.contents as Array<{
                content_id: string;
            }>)[0].content_id
        ).toBe("42");
        expect(properties.currency).toBe("IDR");
    });

    test("TEST 16 — browser and server complete-payment event_id match", async () => {
        const browserEventId = buildTikTokEventId(
            "CompletePayment",
            "PAY-0001"
        );

        expect(browserEventId).toBe(
            "ttq:completepayment:PAY-0001"
        );

        mockPrisma.storeSetting.findUnique.mockResolvedValue({
            tiktokPixelEnabled: true,
            tiktokPixelId: PIXEL_ID,
            tiktokPixelAccessToken: TOKEN,
        });

        fetchMock.mockResolvedValue(jsonResponse({ code: 0 }));

        await trackTikTokServerCompletePayment({
            orderNumber: "PAY-0001",
            total: 50000,
            email: RAW_EMAIL,
            phone: RAW_PHONE,
            userId: "user_abc123",
        });

        const body = JSON.parse(
            String(fetchMock.mock.calls[0][1].body)
        ) as {
            data: Array<{ event_id: string }>;
        };

        expect(body.data[0].event_id).toBe(browserEventId);
    });
});
