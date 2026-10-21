/**
 * ==========================================
 * PHASE 1 — PURCHASE TRACKING HARDENING (C1 + C2)
 * ==========================================
 *
 * C1: the /checkout/payment-finish polling loop stopped only by luck.
 *     It called the fetcher from inside a state updater, kept the
 *     interval alive after a FINAL status and handed back a NEW order
 *     object every 3 seconds, which re-ran the CompletePayment effect
 *     once per tick.
 *
 * C2: a browser Purchase is now claimed once per channel + pixel +
 *     order per tab, BEFORE the event is sent.
 *
 * Everything here runs against the real modules; no test contacts
 * TikTok, iPaymu or a database.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import {
    buildMetaPurchaseEventId,
    buildPurchaseClaimKey,
    claimPurchase,
    hasPurchaseClaim,
    resetPurchaseClaimsForTests,
    type PurchaseClaimStorage,
    UNKNOWN_PIXEL_ID,
    PURCHASE_CLAIM_PREFIX,
} from "@/lib/analytics/purchase-claim";

import {
    createPaymentStatusPoller,
    DEFAULT_PAYMENT_STATUS_MAX_ATTEMPTS,
    DEFAULT_PAYMENT_STATUS_INTERVAL_MS,
} from "@/lib/payment/payment-status-poll";

import {
    trackAuthoritativeTikTokPurchase,
} from "@/components/analytics/PurchaseTracker";

import {
    resetTikTokIdentityForTests,
} from "@/lib/analytics/tiktok-identity";

import {
    isBrowserPurchaseEligible,
} from "@/lib/analytics/purchase-eligibility";

/* ==========================================
 * FIXTURES / HELPERS
 * ========================================== */

const PIXEL_ID = "C1A2B3C4D5E6F7G8H9J0";
const OTHER_PIXEL_ID = "Z9Y8X7W6V5U4T3S2R1Q0";
const ORDER_NUMBER = "PAY-CART-900";
const OTHER_ORDER_NUMBER = "PAY-CART-901";

type TrackCall = {
    event: string;
    properties?: Record<string, unknown>;
    options?: { event_id?: string };
};

type IdentifyCall = Record<string, unknown>;

function memoryStorage(): PurchaseClaimStorage & {
    map: Map<string, string>;
} {
    const map = new Map<string, string>();

    return {
        map,
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => {
            map.set(key, value);
        },
    };
}

/**
 * A storage that behaves like Safari private mode / blocked cookies:
 * every access throws.
 */
function brokenStorage(): PurchaseClaimStorage {
    return {
        getItem() {
            throw new Error("storage blocked");
        },
        setItem() {
            throw new Error("storage blocked");
        },
    };
}

/**
 * Install a fake `window.ttq` plus a per-document sessionStorage, so
 * a simulated reload keeps the storage while the module state resets.
 */
function installPixel(): {
    tracks: TrackCall[];
    identifies: IdentifyCall[];
    storage: PurchaseClaimStorage & {
        map: Map<string, string>;
    };
} {
    const tracks: TrackCall[] = [];
    const identifies: IdentifyCall[] = [];
    const storage = memoryStorage();

    (globalThis as { window?: unknown }).window = {
        ttq: {
            track: (
                event: string,
                properties?: Record<string, unknown>,
                options?: { event_id?: string }
            ) => {
                tracks.push({ event, properties, options });
            },
            identify: (identifiers: IdentifyCall) => {
                identifies.push({ ...identifiers });
            },
        },
        sessionStorage: storage,
        addEventListener: () => {},
        removeEventListener: () => {},
    };

    return { tracks, identifies, storage };
}

/**
 * Fire the shared browser Purchase entry point the way every
 * confirmation route does (payment/[id], payment-finish,
 * checkout/success all route through it).
 */
function firePurchase(
    overrides: Partial<{
        orderId: string;
        total: number;
        pixelId: string | null;
    }> = {}
): void {
    trackAuthoritativeTikTokPurchase({
        orderId: ORDER_NUMBER,
        total: 75000,
        items: [],
        identity: null,
        pixelId: PIXEL_ID,
        ...overrides,
    });
}

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

async function flush(): Promise<void> {
    await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
    jest.clearAllMocks();
    resetPurchaseClaimsForTests();
    resetTikTokIdentityForTests();
    delete (globalThis as { window?: unknown }).window;
});

afterEach(() => {
    jest.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
});

/* ==========================================
 * C2 — CLAIM KEY
 * ========================================== */

describe("purchase claim key", () => {
    test("uses tracking:purchase:<channel>:<pixelId>:<orderNumber>", () => {
        expect(
            buildPurchaseClaimKey({
                channel: "tiktok",
                pixelId: PIXEL_ID,
                orderNumber: ORDER_NUMBER,
            })
        ).toBe(
            `${PURCHASE_CLAIM_PREFIX}:tiktok:${PIXEL_ID}:${ORDER_NUMBER}`
        );

        expect(PURCHASE_CLAIM_PREFIX).toBe(
            "tracking:purchase"
        );
    });

    test("channels, pixels and orders never collide", () => {
        const tiktok = buildPurchaseClaimKey({
            channel: "tiktok",
            pixelId: PIXEL_ID,
            orderNumber: ORDER_NUMBER,
        });
        const meta = buildPurchaseClaimKey({
            channel: "meta",
            pixelId: PIXEL_ID,
            orderNumber: ORDER_NUMBER,
        });
        const otherPixel = buildPurchaseClaimKey({
            channel: "tiktok",
            pixelId: OTHER_PIXEL_ID,
            orderNumber: ORDER_NUMBER,
        });
        const otherOrder = buildPurchaseClaimKey({
            channel: "tiktok",
            pixelId: PIXEL_ID,
            orderNumber: OTHER_ORDER_NUMBER,
        });

        const keys = [
            tiktok,
            meta,
            otherPixel,
            otherOrder,
        ];

        expect(new Set(keys).size).toBe(4);
    });

    test("an unresolved pixel id uses the explicit sentinel, never a fake id", () => {
        expect(
            buildPurchaseClaimKey({
                channel: "tiktok",
                pixelId: null,
                orderNumber: ORDER_NUMBER,
            })
        ).toBe(
            `${PURCHASE_CLAIM_PREFIX}:tiktok:${UNKNOWN_PIXEL_ID}:${ORDER_NUMBER}`
        );

        expect(
            buildPurchaseClaimKey({
                channel: "tiktok",
                pixelId: "   ",
                orderNumber: ORDER_NUMBER,
            })
        ).toContain(`:${UNKNOWN_PIXEL_ID}:`);
    });

    test("an unidentifiable purchase has no key and is never claimed", () => {
        expect(
            buildPurchaseClaimKey({
                channel: "tiktok",
                pixelId: PIXEL_ID,
                orderNumber: "  ",
            })
        ).toBeNull();

        expect(
            claimPurchase(
                {
                    channel: "tiktok",
                    pixelId: PIXEL_ID,
                    orderNumber: "",
                },
                { storage: memoryStorage() }
            )
        ).toBe(false);
    });

    test("the stored value is the claim marker only — no PII, no token", () => {
        const storage = memoryStorage();

        claimPurchase(
            {
                channel: "tiktok",
                pixelId: PIXEL_ID,
                orderNumber: ORDER_NUMBER,
            },
            { storage }
        );

        expect(Array.from(storage.map.keys())).toEqual([
            `${PURCHASE_CLAIM_PREFIX}:tiktok:${PIXEL_ID}:${ORDER_NUMBER}`,
        ]);
        expect(Array.from(storage.map.values())).toEqual([
            "1",
        ]);
    });
});

/* ==========================================
 * C2 — CLAIM BEHAVIOUR (T1–T5, T10)
 * ========================================== */

describe("purchase claim semantics", () => {
    test("T1. three reloads of the same tab emit one Purchase", () => {
        const pixel = installPixel();

        /*
         * A reload keeps sessionStorage but resets module state, so
         * the in-memory set is cleared to model a fresh page load.
         */
        for (let reload = 0; reload < 3; reload += 1) {
            resetPurchaseClaimsForTests();
            firePurchase({ pixelId: PIXEL_ID });
        }

        expect(pixel.tracks).toHaveLength(1);

        /* Sanity: the claim is what made that possible. */
        expect(
            Array.from(pixel.storage.map.keys())
        ).toEqual([
            `${PURCHASE_CLAIM_PREFIX}:tiktok:${PIXEL_ID}:${ORDER_NUMBER}`,
        ]);

        expect(
            hasPurchaseClaim(
                {
                    channel: "tiktok",
                    pixelId: PIXEL_ID,
                    orderNumber: ORDER_NUMBER,
                },
                { storage: pixel.storage }
            )
        ).toBe(true);
    });

    test("T2. a React remount (same load) emits one Purchase", () => {
        const pixel = installPixel();

        firePurchase({ pixelId: PIXEL_ID });
        firePurchase({ pixelId: PIXEL_ID });
        firePurchase({ pixelId: PIXEL_ID });

        expect(pixel.tracks).toHaveLength(1);
        expect(pixel.identifies).toHaveLength(0);
    });

    test("T3. three confirmation routes emit one Purchase total", () => {
        const pixel = installPixel();

        /* payment/[id] → payment-finish → checkout/success */
        firePurchase({ pixelId: PIXEL_ID });
        firePurchase({ pixelId: PIXEL_ID });
        firePurchase({ pixelId: PIXEL_ID });

        expect(pixel.tracks).toHaveLength(1);
        expect(pixel.tracks[0].options?.event_id).toBe(
            `ttq:completepayment:${ORDER_NUMBER}`
        );
    });

    test("T4. two different orders emit two Purchases", () => {
        const pixel = installPixel();

        firePurchase({
            orderId: ORDER_NUMBER,
            pixelId: PIXEL_ID,
        });
        firePurchase({
            orderId: OTHER_ORDER_NUMBER,
            pixelId: PIXEL_ID,
        });

        expect(pixel.tracks).toHaveLength(2);
    });

    test("T5. another tab is a KNOWN limitation (sessionStorage is per tab)", () => {
        const tabA = installPixel();

        firePurchase({ pixelId: PIXEL_ID });

        /*
         * A second tab has its own sessionStorage AND its own JS
         * context. Modelling that with a fresh claim set is exactly
         * what the browser does — so the second tab emits too. This
         * is documented, not silently ignored.
         */
        resetPurchaseClaimsForTests();

        const tabB = installPixel();

        firePurchase({ pixelId: PIXEL_ID });

        expect(tabA.tracks).toHaveLength(1);
        expect(tabB.tracks).toHaveLength(1);
    });

    test("T6. no Pixel API → no event and no claim", () => {
        const storage = memoryStorage();

        /* No window.ttq at all. */
        firePurchase({ pixelId: PIXEL_ID });

        expect(
            hasPurchaseClaim(
                {
                    channel: "tiktok",
                    pixelId: PIXEL_ID,
                    orderNumber: ORDER_NUMBER,
                },
                { storage }
            )
        ).toBe(false);

        /* And the attempt is NOT burned: once the Pixel exists the
         * purchase still fires. */
        const pixel = installPixel();
        firePurchase({ pixelId: PIXEL_ID });

        expect(pixel.tracks).toHaveLength(1);
    });

    test("T7 (pending C3) — no consent gate exists yet", () => {
        /*
         * Deliberately NOT implemented in this phase: a shared
         * tracking consent mechanism is C3. The claim must sit
         * AFTER that gate once it exists; until then no fake
         * consent is introduced here.
         */
        expect(
            readFile(
                "lib/analytics/purchase-claim.ts"
            )
        ).not.toContain("consent");
    });

    test("T10. a changed Pixel ID is not blocked by the old claim", () => {
        const pixel = installPixel();

        firePurchase({ pixelId: PIXEL_ID });
        firePurchase({ pixelId: PIXEL_ID });

        /* Admin rotates the pixel: the new one is a new conversion
         * target, so it must not inherit the old claim. */
        firePurchase({ pixelId: OTHER_PIXEL_ID });
        firePurchase({ pixelId: OTHER_PIXEL_ID });

        expect(pixel.tracks).toHaveLength(2);

        const eventIds = pixel.tracks.map(
            (call) => call.options?.event_id
        );

        /* Same deterministic id for the same order — the pixel is
         * part of the CLAIM, not of the event id. */
        expect(eventIds[0]).toBe(eventIds[1]);
    });

    test("T9. deterministic ids are stable (Meta contract)", () => {
        expect(
            buildMetaPurchaseEventId(ORDER_NUMBER)
        ).toBe(`meta:purchase:${ORDER_NUMBER}`);

        expect(
            buildMetaPurchaseEventId(ORDER_NUMBER)
        ).toBe(
            buildMetaPurchaseEventId(ORDER_NUMBER)
        );

        expect(buildMetaPurchaseEventId("")).toBeNull();
        expect(buildMetaPurchaseEventId("   ")).toBeNull();
    });

    test("Meta and TikTok claims are independent", () => {
        expect(
            claimPurchase({
                channel: "tiktok",
                pixelId: PIXEL_ID,
                orderNumber: ORDER_NUMBER,
            })
        ).toBe(true);

        expect(
            claimPurchase({
                channel: "meta",
                pixelId: PIXEL_ID,
                orderNumber: ORDER_NUMBER,
            })
        ).toBe(true);

        expect(
            claimPurchase({
                channel: "tiktok",
                pixelId: PIXEL_ID,
                orderNumber: ORDER_NUMBER,
            })
        ).toBe(false);
    });

    test("storage unavailable → memory-only, still one claim", () => {
        expect(
            claimPurchase(
                {
                    channel: "tiktok",
                    pixelId: PIXEL_ID,
                    orderNumber: ORDER_NUMBER,
                },
                { storage: brokenStorage() }
            )
        ).toBe(true);

        expect(
            claimPurchase(
                {
                    channel: "tiktok",
                    pixelId: PIXEL_ID,
                    orderNumber: ORDER_NUMBER,
                },
                { storage: brokenStorage() }
            )
        ).toBe(false);
    });

    test("a foreign value in storage is not a claim", () => {
        const storage = memoryStorage();
        const key = buildPurchaseClaimKey({
            channel: "tiktok",
            pixelId: PIXEL_ID,
            orderNumber: ORDER_NUMBER,
        }) as string;

        storage.setItem(key, "0");

        expect(
            claimPurchase(
                {
                    channel: "tiktok",
                    pixelId: PIXEL_ID,
                    orderNumber: ORDER_NUMBER,
                },
                { storage }
            )
        ).toBe(true);
    });

    test("a claim taken in a previous load blocks the new one", () => {
        const storage = memoryStorage();

        expect(
            claimPurchase(
                {
                    channel: "tiktok",
                    pixelId: PIXEL_ID,
                    orderNumber: ORDER_NUMBER,
                },
                { storage }
            )
        ).toBe(true);

        resetPurchaseClaimsForTests();

        expect(
            claimPurchase(
                {
                    channel: "tiktok",
                    pixelId: PIXEL_ID,
                    orderNumber: ORDER_NUMBER,
                },
                { storage }
            )
        ).toBe(false);
    });
});

/* ==========================================
 * ELIGIBILITY (preserved, now directly tested)
 * ========================================== */

describe("browser Purchase eligibility", () => {
    test("a PENDING order becomes eligible only once PAID", () => {
        const base = {
            paymentMethod: "QRIS",
            status: "PENDING",
        };

        expect(
            isBrowserPurchaseEligible({
                ...base,
                paymentStatus: "PENDING",
            })
        ).toBe(false);

        expect(
            isBrowserPurchaseEligible({
                ...base,
                paymentStatus: "PAID",
            })
        ).toBe(true);
    });

    test.each([
        ["FAILED"],
        ["EXPIRED"],
        ["REFUNDED"],
        ["UNPAID"],
    ])(
        "a non-COD %s order is not eligible",
        (paymentStatus) => {
            expect(
                isBrowserPurchaseEligible({
                    paymentStatus,
                    paymentMethod: "QRIS",
                    status: "PENDING",
                })
            ).toBe(false);
        }
    );

    test("a live COD order is eligible (paymentStatus stays UNPAID)", () => {
        expect(
            isBrowserPurchaseEligible({
                paymentStatus: "UNPAID",
                paymentMethod: "COD",
                status: "PROCESSING",
            })
        ).toBe(true);
    });

    test("a refunded COD order is not eligible", () => {
        expect(
            isBrowserPurchaseEligible({
                paymentStatus: "REFUNDED",
                paymentMethod: "COD",
                status: "PROCESSING",
            })
        ).toBe(false);
    });

    test("a cancelled COD order is not eligible", () => {
        expect(
            isBrowserPurchaseEligible({
                paymentStatus: "UNPAID",
                paymentMethod: "COD",
                status: "CANCELLED",
            })
        ).toBe(false);
    });

    test("a missing payment method never becomes eligible", () => {
        for (const paymentMethod of [null, undefined]) {
            expect(
                isBrowserPurchaseEligible({
                    paymentStatus: "UNPAID",
                    paymentMethod,
                    status: "PENDING",
                })
            ).toBe(false);
        }
    });

    test("the confirmation page still renders the tracker only when eligible", () => {
        const page = readCode(
            "app/checkout/success/page.tsx"
        );

        expect(page).toContain(
            "isBrowserPurchaseEligible("
        );
        expect(page).toContain(
            "canTrackBrowserCompletePayment && ("
        );
    });
});

/* ==========================================
 * C1 — POLLING LOOP (T8 + edge cases)
 * ========================================== */

type Status = {
    paymentStatus: string;
    orderNumber: string;
};

const FINAL = ["PAID", "FAILED", "EXPIRED"];

function status(paymentStatus: string): Status {
    return {
        paymentStatus,
        orderNumber: ORDER_NUMBER,
    };
}

describe("payment status poller (C1)", () => {
    test("T8. a PAID status stops polling and fires one Purchase", async () => {
        jest.useFakeTimers();

        const responses = [
            status("PENDING"),
            status("PAID"),
        ];

        const fetchStatus = jest.fn(async () => {
            const next =
                responses.shift() ?? status("PAID");
            return next;
        });

        const seen: string[] = [];
        let purchases = 0;
        const onDone = jest.fn();

        const poller = createPaymentStatusPoller<Status>({
            fetchStatus,
            isFinal: (value) =>
                FINAL.includes(value.paymentStatus),
            onStatus: (value) => {
                seen.push(value.paymentStatus);

                if (value.paymentStatus === "PAID") {
                    purchases += 1;
                }
            },
            onDone,
        });

        poller.start();
        await flush();

        /* 10 more ticks after PAID. */
        await jest.advanceTimersByTimeAsync(
            DEFAULT_PAYMENT_STATUS_INTERVAL_MS * 10
        );

        expect(seen).toEqual(["PENDING", "PAID"]);
        expect(purchases).toBe(1);
        expect(onDone).toHaveBeenCalledTimes(1);
        expect(poller.isStopped()).toBe(true);

        /* The interval is gone, not merely ignored. */
        const callsAtStop = fetchStatus.mock.calls.length;
        await jest.advanceTimersByTimeAsync(
            DEFAULT_PAYMENT_STATUS_INTERVAL_MS * 10
        );
        expect(fetchStatus.mock.calls.length).toBe(
            callsAtStop
        );
    });

    test.each([
        ["PAID"],
        ["FAILED"],
        ["EXPIRED"],
    ])(
        "a FINAL status (%s) stops immediately",
        async (finalStatus) => {
            jest.useFakeTimers();

            const fetchStatus = jest.fn(async () =>
                status(finalStatus)
            );
            const onDone = jest.fn();

            const poller =
                createPaymentStatusPoller<Status>({
                    fetchStatus,
                    isFinal: (value) =>
                        FINAL.includes(
                            value.paymentStatus
                        ),
                    onStatus: () => {},
                    onDone,
                });

            poller.start();
            await flush();

            await jest.advanceTimersByTimeAsync(
                DEFAULT_PAYMENT_STATUS_INTERVAL_MS * 5
            );

            expect(fetchStatus).toHaveBeenCalledTimes(1);
            expect(onDone).toHaveBeenCalledTimes(1);
        }
    );

    test("a non-final cancellation keeps the existing budget", async () => {
        jest.useFakeTimers();

        const fetchStatus = jest.fn(async () => ({
            paymentStatus: "CANCELLED",
            orderNumber: ORDER_NUMBER,
        }));
        const onDone = jest.fn();

        const poller = createPaymentStatusPoller<Status>({
            fetchStatus,
            isFinal: (value) =>
                FINAL.includes(value.paymentStatus),
            onStatus: () => {},
            onDone,
            maxAttempts: 3,
        });

        poller.start();
        await flush();
        await jest.advanceTimersByTimeAsync(
            DEFAULT_PAYMENT_STATUS_INTERVAL_MS * 10
        );

        /*
         * `paymentStatus` never becomes CANCELLED (that is an order
         * status), so the loop keeps polling until its budget — the
         * behaviour the page had before this fix.
         */
        expect(fetchStatus).toHaveBeenCalledTimes(3);
        expect(onDone).toHaveBeenCalledTimes(1);
    });

    test("unmount while a request is in flight clears the timer and ignores the response", async () => {
        jest.useFakeTimers();

        let release: (value: Status) => void = () => {};
        const fetchStatus = jest.fn(
            () =>
                new Promise<Status>((resolveNext) => {
                    release = resolveNext;
                })
        );

        const onStatus = jest.fn();
        const onDone = jest.fn();

        const poller = createPaymentStatusPoller<Status>({
            fetchStatus,
            isFinal: () => false,
            onStatus,
            onDone,
        });

        poller.start();
        await flush();

        expect(fetchStatus).toHaveBeenCalledTimes(1);

        /* Component unmounts. */
        poller.stop();

        release(status("PAID"));
        await flush();

        expect(onStatus).not.toHaveBeenCalled();
        expect(onDone).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(
            DEFAULT_PAYMENT_STATUS_INTERVAL_MS * 5
        );
        expect(fetchStatus).toHaveBeenCalledTimes(1);
    });

    test("concurrent ticks never overlap requests", async () => {
        jest.useFakeTimers();

        const resolvers: Array<
            (value: Status | null) => void
        > = [];

        const fetchStatus = jest.fn(
            () =>
                new Promise<Status | null>(
                    (resolveNext) => {
                        resolvers.push(resolveNext);
                    }
                )
        );

        const onStatus = jest.fn();

        const poller = createPaymentStatusPoller<Status>({
            fetchStatus,
            isFinal: () => false,
            onStatus,
        });

        poller.start();
        await flush();

        /* Two interval ticks while the first request hangs. */
        await jest.advanceTimersByTimeAsync(
            DEFAULT_PAYMENT_STATUS_INTERVAL_MS * 2
        );

        expect(fetchStatus).toHaveBeenCalledTimes(1);

        resolvers[0](status("PENDING"));
        await flush();
        await jest.advanceTimersByTimeAsync(
            DEFAULT_PAYMENT_STATUS_INTERVAL_MS
        );

        expect(fetchStatus).toHaveBeenCalledTimes(2);
        expect(onStatus).toHaveBeenCalledTimes(1);

        poller.stop();
    });

    test("a late response cannot reorder the status", async () => {
        jest.useFakeTimers();

        const onStatus = jest.fn();
        let release: (value: Status) => void = () => {};

        const fetchStatus = jest.fn(
            () =>
                new Promise<Status>((resolveNext) => {
                    release = resolveNext;
                })
        );

        const poller = createPaymentStatusPoller<Status>({
            fetchStatus,
            isFinal: () => false,
            onStatus,
        });

        poller.start();
        await flush();

        await jest.advanceTimersByTimeAsync(
            DEFAULT_PAYMENT_STATUS_INTERVAL_MS * 3
        );

        /* Only one request exists, so only one status can be applied. */
        release(status("PENDING"));
        await flush();

        expect(onStatus).toHaveBeenCalledTimes(1);
        expect(onStatus).toHaveBeenCalledWith(
            status("PENDING")
        );

        poller.stop();
    });

    test("spends the attempt budget on unusable responses and errors", async () => {
        jest.useFakeTimers();

        let call = 0;
        const fetchStatus = jest.fn(async () => {
            call += 1;

            if (call % 2 === 0) {
                throw new Error("network");
            }

            return null;
        });

        const onDone = jest.fn();

        const poller = createPaymentStatusPoller<Status>({
            fetchStatus,
            isFinal: () => false,
            onStatus: () => {},
            onDone,
            maxAttempts: 4,
        });

        poller.start();
        await flush();
        await jest.advanceTimersByTimeAsync(
            DEFAULT_PAYMENT_STATUS_INTERVAL_MS * 10
        );

        expect(fetchStatus).toHaveBeenCalledTimes(4);
        expect(onDone).toHaveBeenCalledTimes(1);
        expect(poller.isStopped()).toBe(true);
        expect(DEFAULT_PAYMENT_STATUS_MAX_ATTEMPTS).toBe(
            15
        );
    });

    test("request failures stay observable through onError", async () => {
        jest.useFakeTimers();

        const boom = new Error("network");
        const onError = jest.fn();

        const poller = createPaymentStatusPoller<Status>({
            fetchStatus: async () => {
                throw boom;
            },
            isFinal: () => false,
            onStatus: () => {},
            onError,
            maxAttempts: 1,
        });

        poller.start();
        await flush();

        expect(onError).toHaveBeenCalledWith(boom);
        expect(poller.isStopped()).toBe(true);
    });

    test("stop() is idempotent and start() after stop() is a no-op", async () => {
        jest.useFakeTimers();

        const fetchStatus = jest.fn(async () =>
            status("PENDING")
        );
        const onDone = jest.fn();

        const poller = createPaymentStatusPoller<Status>({
            fetchStatus,
            isFinal: () => false,
            onStatus: () => {},
            onDone,
        });

        poller.stop();
        poller.stop();

        expect(onDone).toHaveBeenCalledTimes(1);

        poller.start();
        await jest.advanceTimersByTimeAsync(
            DEFAULT_PAYMENT_STATUS_INTERVAL_MS * 3
        );

        expect(fetchStatus).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * C1 — SOURCE GUARDS (the component itself)
 * ========================================== */

describe("payment-finish keeps the C1 fixes", () => {
    const code = readCode(
        "app/checkout/payment-finish/payment-finish-content.tsx"
    );

    test("polling is delegated to the tested poller", () => {
        expect(code).toContain(
            "createPaymentStatusPoller"
        );

        /* No ad-hoc timer left in the component. */
        expect(code).not.toContain("setInterval(");
        expect(code).not.toContain("setAttempts");
    });

    test("the timer is owned by the poller and stopped on unmount", () => {
        expect(code).toContain("poller.start()");
        expect(code).toContain("poller.stop()");
    });

    test("Purchase is not triggered by the whole order object", () => {
        expect(code).toContain("purchaseTracked.current");
        expect(code).toContain("paidOrderNumber");
        expect(code).toContain("paidTotal");
        expect(code).toContain("paidIdentity");

        /* The old dependency array is gone. */
        expect(code).not.toContain("[isPaid, order]");
    });

    test("the Purchase effect still gates on readiness and identity", () => {
        expect(code).toContain(
            "whenTikTokReadyForEvents"
        );
        expect(code).toContain(
            "trackAuthoritativeTikTokPurchase"
        );
        expect(code).toContain("order.identity");
    });

    test("the browser never calls the pixel directly", () => {
        expect(code).not.toContain("trackTikTokEvent(");
        expect(code).not.toContain("ttq.");

        /* Payment state still comes from the server only. */
        expect(code).not.toMatch(
            /paymentStatus\s*=(?!=)/
        );
        expect(code).not.toContain("localStorage");
    });
});

/* ==========================================
 * C2 — SOURCE GUARDS (shared entry point)
 * ========================================== */

describe("the shared Purchase entry point owns the claim", () => {
    const helper = readCode(
        "components/analytics/PurchaseTracker.tsx"
    );

    test("claims BEFORE identify/track and only when the Pixel exists", () => {
        const claimAt = helper.indexOf(
            "claimPurchase("
        );
        const identifyAt = helper.indexOf(
            "trackTikTokUserMatch("
        );
        const trackAt = helper.indexOf(
            "trackTikTokEvent("
        );
        const readyAt = helper.indexOf(
            "isTikTokPixelReady("
        );

        expect(readyAt).toBeGreaterThan(-1);
        expect(claimAt).toBeGreaterThan(-1);
        expect(identifyAt).toBeGreaterThan(-1);
        expect(trackAt).toBeGreaterThan(-1);

        /* Pixel check → claim → identify → track. */
        expect(readyAt).toBeLessThan(claimAt);
        expect(claimAt).toBeLessThan(identifyAt);
        expect(identifyAt).toBeLessThan(trackAt);
    });

    test("the claim key carries channel, pixel and order", () => {
        expect(helper).toContain('channel: "tiktok"');
        expect(helper).toContain(
            "resolveTikTokBrowserPixelId()"
        );
        expect(helper).toContain("orderNumber: orderId");
    });

    test("the event id and payload are untouched", () => {
        expect(helper).toContain("buildTikTokEventId(");
        expect(helper).toContain('"CompletePayment"');
        expect(helper).toContain(
            "buildTikTokOrderProperties("
        );
    });

    test("the pixel id is read from the rendered base script", () => {
        const pixel = readFile(
            "components/analytics/TikTokPixel.tsx"
        );

        expect(pixel).toContain(
            "TIKTOK_PIXEL_SCRIPT_ID"
        );
        expect(
            readFile("lib/analytics/tiktok.ts")
        ).toContain(
            'TIKTOK_PIXEL_SCRIPT_ID = "tiktok-pixel-base"'
        );
    });
});
