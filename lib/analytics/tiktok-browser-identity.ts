import {
    trackTikTokUserMatch,
    whenTikTokPixelReady,
    type TikTokUserMatchIdentifiers,
} from "@/lib/analytics/tiktok";
import { settleTikTokIdentity } from "@/lib/analytics/tiktok-identity";

/**
 * ==========================================
 * TIKTOK BROWSER ADVANCED MATCHING — BOOTSTRAP
 * ==========================================
 *
 * Owns the browser-side Advanced Matching lifecycle so the
 * ordering is deterministic:
 *
 *     Pixel ready
 *          ↓
 *     matching data ready   (GET /api/analytics/tiktok-match)
 *          ↓
 *     register identifiers with the Pixel (identify API)
 *          ↓
 *     identity settled → eligible events may fire
 *
 * WHY THIS MODULE EXISTS (the bug it fixes):
 *   The previous implementation settled the identity store as
 *   ANONYMOUS whenever the Pixel became ready before the matching
 *   lookup finished. The base code is `afterInteractive`, so
 *   `window.ttq` normally exists long before a network round-trip
 *   completes — meaning an authenticated visitor's first events
 *   (ViewContent, InitiateCheckout, …) fired WITHOUT email/phone
 *   even though the lookup was still in flight.
 *
 *   Here, the store is released anonymously ONLY after the lookup
 *   has actually resolved with nothing usable. While the lookup is
 *   in flight the store stays pending, so no eligible event can
 *   beat its own matching data.
 *
 * CONTRACT:
 *   - the fetch runs ONCE per full page load (module-level cache)
 *   - module-level state, so SPA navigation / re-mounts cannot
 *     reset or lose an in-flight lookup
 *   - bounded by a timeout: a hanging endpoint resolves to "no
 *     matching data" instead of stalling events (the event helper
 *     has its own hard cap as a second line of defence)
 *   - never logs, never stores, never sends raw PII anywhere but
 *     the Pixel identify call (which TikTok hashes client-side)
 */

export type TikTokBrowserMatchData = {
    email?: unknown;
    phone_number?: unknown;
    external_id?: unknown;
};

/**
 * Endpoint the browser calls for its own normalized identifiers.
 * Authenticated-only: anonymous callers get `{}`.
 */
export const TIKTOK_BROWSER_MATCH_ENDPOINT =
    "/api/analytics/tiktok-match";

/**
 * Upper bound on the matching lookup. Kept comfortably below the
 * event helper's identity budget so a slow endpoint resolves to
 * "anonymous" well before events would time out.
 */
export const TIKTOK_BROWSER_MATCH_TIMEOUT_MS = 2500;

let browserMatchPromise: Promise<TikTokBrowserMatchData> | null =
    null;

let matchRequested = false;
let matchResolved = false;
let matchApplied = false;
let matchIdentifiers: TikTokUserMatchIdentifiers | null =
    null;

function readString(value: unknown): string | undefined {
    return typeof value === "string" && value
        ? value
        : undefined;
}

/**
 * Map the endpoint payload onto TikTok's `identify()` names,
 * omitting anything unusable. Returns null when there is nothing.
 */
export function toTikTokBrowserIdentifiers(
    data: TikTokBrowserMatchData
): TikTokUserMatchIdentifiers | null {
    const identifiers: TikTokUserMatchIdentifiers = {};

    const email = readString(data?.email);

    if (email) {
        identifiers.email = email;
    }

    const phone = readString(data?.phone_number);

    if (phone) {
        identifiers.phone_number = phone;
    }

    const externalId = readString(data?.external_id);

    if (externalId) {
        identifiers.external_id = externalId;
    }

    return Object.keys(identifiers).length > 0
        ? identifiers
        : null;
}

/**
 * One in-flight (or already resolved) lookup per full page load.
 * SPA navigations reuse it, so matching keys never cost a request
 * per route change. Never throws: any failure becomes "no data".
 */
export function loadTikTokBrowserMatch(): Promise<TikTokBrowserMatchData> {
    if (!browserMatchPromise) {
        browserMatchPromise = (async () => {
            const controller = new AbortController();

            const timeout = setTimeout(
                () => controller.abort(),
                TIKTOK_BROWSER_MATCH_TIMEOUT_MS
            );

            try {
                const response = await fetch(
                    TIKTOK_BROWSER_MATCH_ENDPOINT,
                    {
                        cache: "no-store",
                        credentials: "same-origin",
                        signal: controller.signal,
                    }
                );

                if (!response.ok) {
                    return {};
                }

                const body = (await response.json()) as {
                    data?: TikTokBrowserMatchData;
                };

                return body?.data ?? {};
            } catch {
                /*
                 * Tracking must never surface an error to the
                 * customer or the console.
                 */
                return {};
            } finally {
                clearTimeout(timeout);
            }
        })();
    }

    return browserMatchPromise;
}

/**
 * Register the resolved identifiers with the Pixel, then release
 * the identity store.
 *
 * KEY INVARIANT: while the lookup is still in flight this does
 * NOTHING — it never settles the store as anonymous. Only a lookup
 * that has genuinely finished without usable keys settles
 * anonymous, so an authenticated event can never fire before its
 * own matching data.
 */
export function applyTikTokBrowserIdentity(): void {
    if (matchApplied) {
        return;
    }

    if (!matchIdentifiers) {
        if (matchResolved) {
            settleTikTokIdentity(null);
        }

        return;
    }

    const identifiers = matchIdentifiers;

    whenTikTokPixelReady(() => {
        if (matchApplied) {
            return;
        }

        if (trackTikTokUserMatch(identifiers)) {
            matchApplied = true;
            settleTikTokIdentity(identifiers);
        }
    });
}

/**
 * Start (once) the browser matching lookup and apply it to the
 * Pixel. Idempotent and independent of React lifecycle, so
 * StrictMode double-mounts and SPA re-mounts cannot lose it.
 */
export function bootstrapTikTokBrowserIdentity(): void {
    if (matchApplied) {
        return;
    }

    if (!matchRequested) {
        matchRequested = true;

        void loadTikTokBrowserMatch().then((data) => {
            matchResolved = true;
            matchIdentifiers =
                toTikTokBrowserIdentifiers(data);
            applyTikTokBrowserIdentity();
        });

        return;
    }

    /*
     * A later mount while the request is already in flight: the
     * pending `.then` above will apply it. If it has already
     * resolved, apply now (e.g. the Pixel became ready late).
     */
    if (matchResolved) {
        applyTikTokBrowserIdentity();
    }
}

/** True once the Pixel has accepted the matching identifiers. */
export function isTikTokBrowserIdentityApplied(): boolean {
    return matchApplied;
}

/**
 * Test-only reset so the module-level state does not leak between
 * tests.
 */
export function resetTikTokBrowserIdentityForTests(): void {
    browserMatchPromise = null;
    matchRequested = false;
    matchResolved = false;
    matchApplied = false;
    matchIdentifiers = null;
}
