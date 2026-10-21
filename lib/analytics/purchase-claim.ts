/**
 * ==========================================
 * BROWSER PURCHASE CLAIM
 * ==========================================
 *
 * One reusable, browser-side guard that answers a single question:
 * "has this purchase already been claimed for this channel, pixel and
 * order in THIS browser tab?"
 *
 * WHY THIS EXISTS
 *   A conversion page can mount, remount and reload several times for
 *   the same order (payment-finish polling, /checkout/payment/[id]
 *   settling, a customer reloading the success page). Each of those
 *   used to be able to fire a browser Purchase again, inflating the
 *   reported conversions.
 *
 *   A deterministic `event_id` is NOT a browser-side deduplication
 *   mechanism: TikTok/Meta only dedupe a browser event against a
 *   SERVER event that carries the same id. Two browser events with
 *   the same id are both recorded. The claim below is what stops the
 *   second BROWSER event from being sent at all.
 *
 * SCOPE (deliberate, documented limitations)
 *   - in-memory Set: survives a React remount and client-side
 *     navigation within the same page load
 *   - sessionStorage: survives a reload of the same tab
 *   - NOT shared across tabs / browsers / devices: a second tab is a
 *     known limitation of a browser-only guard (see
 *     docs/meta-pixel/PHASE-1-C1-C2-PURCHASE-HARDENING.md)
 *   - NO retry: a claim means "we attempted once", never "the vendor
 *     accepted it". A failed/dropped request will not be re-sent.
 *   - NO PII, NO access token, NO order value is stored. The stored
 *     value is the literal "1"; the key carries the channel, the
 *     pixel id and the public order number only.
 */

/** Tracking channel. Meta and TikTok never share a claim. */
export type PurchaseChannel = "tiktok" | "meta";

export type PurchaseClaimInput = {
    channel: PurchaseChannel;
    /**
     * Pixel / dataset id the conversion would be sent to.
     *
     * Part of the key on purpose: switching the configured pixel must
     * never be blocked by a claim created for the previous one.
     */
    pixelId: string | null | undefined;
    /** Public order number (never a database id or a customer id). */
    orderNumber: string;
};

/**
 * The tiny slice of `sessionStorage` used here, so tests can inject a
 * fake (or a throwing) implementation without a DOM.
 */
export type PurchaseClaimStorage = {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
};

export type PurchaseClaimOptions = {
    /**
     * `undefined` → use `window.sessionStorage` when available.
     * `null` → force memory-only (storage unavailable / blocked).
     */
    storage?: PurchaseClaimStorage | null;
};

/** Prefix of every claim key written to storage. */
export const PURCHASE_CLAIM_PREFIX = "tracking:purchase";

/**
 * Segment used when the browser cannot resolve a pixel id (for
 * example: pixel enabled but no id saved in the admin settings).
 *
 * It is an explicit sentinel, NOT a fabricated pixel id: the claim
 * still separates channels and orders, and a claim created under the
 * sentinel never blocks a real pixel id resolved later.
 */
export const UNKNOWN_PIXEL_ID = "unknown";

/** Value written to storage. Nothing else is stored. */
const CLAIMED_VALUE = "1";

const claimedInMemory = new Set<string>();

function normalizeSegment(
    value: string | null | undefined
): string {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the claim key:
 *
 *   tracking:purchase:<channel>:<pixelId>:<orderNumber>
 *
 * Returns null when the claim cannot identify a purchase (empty
 * channel or empty order number). A null key is never claimed, so the
 * caller must treat it as "not claimed".
 *
 * Segments are trimmed but not escaped: order numbers and pixel ids
 * are `[A-Z0-9-]` style tokens and never contain the ":" delimiter.
 */
export function buildPurchaseClaimKey(
    input: PurchaseClaimInput
): string | null {
    const channel = normalizeSegment(
        input.channel
    ).toLowerCase();

    const orderNumber = normalizeSegment(
        input.orderNumber
    );

    if (!channel || !orderNumber) {
        return null;
    }

    const pixelId =
        normalizeSegment(input.pixelId) ||
        UNKNOWN_PIXEL_ID;

    return `${PURCHASE_CLAIM_PREFIX}:${channel}:${pixelId}:${orderNumber}`;
}

/**
 * Resolve the storage to use.
 *
 * Every access is wrapped: `window.sessionStorage` itself can throw
 * (blocked cookies, private mode, embedded webview) and a tracking
 * guard must never break the page it protects.
 */
function resolveStorage(
    explicit: PurchaseClaimStorage | null | undefined
): PurchaseClaimStorage | null {
    if (explicit !== undefined) {
        return explicit;
    }

    if (typeof window === "undefined") {
        return null;
    }

    try {
        return window.sessionStorage ?? null;
    } catch {
        return null;
    }
}

function readStoredClaim(
    storage: PurchaseClaimStorage | null,
    key: string
): boolean {
    if (!storage) {
        return false;
    }

    try {
        return storage.getItem(key) === CLAIMED_VALUE;
    } catch {
        return false;
    }
}

function writeStoredClaim(
    storage: PurchaseClaimStorage | null,
    key: string
): void {
    if (!storage) {
        return;
    }

    try {
        storage.setItem(key, CLAIMED_VALUE);
    } catch {
        /*
         * Quota / blocked storage: the in-memory Set still guards
         * this page load. Losing cross-reload protection is
         * preferable to dropping the event entirely.
         */
    }
}

/**
 * True when this purchase was already claimed for the channel +
 * pixel + order in this tab.
 */
export function hasPurchaseClaim(
    input: PurchaseClaimInput,
    options?: PurchaseClaimOptions
): boolean {
    const key = buildPurchaseClaimKey(input);

    if (!key) {
        return false;
    }

    if (claimedInMemory.has(key)) {
        return true;
    }

    return readStoredClaim(
        resolveStorage(options?.storage),
        key
    );
}

/**
 * Claim a purchase exactly once.
 *
 * Returns true ONLY for the caller that won the claim; that caller is
 * then allowed to send the event. Returns false when the purchase was
 * already claimed (this load, a previous reload, or another route in
 * this tab).
 *
 * The claim is written BEFORE the caller sends the event, so a
 * re-entrant call (double effect, Strict Mode remount, overlapping
 * response) can never emit twice.
 *
 * A `true` result is not a delivery guarantee: the event may still be
 * blocked, throttled or dropped by the vendor.
 */
export function claimPurchase(
    input: PurchaseClaimInput,
    options?: PurchaseClaimOptions
): boolean {
    const key = buildPurchaseClaimKey(input);

    if (!key) {
        return false;
    }

    /*
     * Synchronous check-then-write: JavaScript runs this to
     * completion, so two calls in the same task cannot both win.
     */
    if (claimedInMemory.has(key)) {
        return false;
    }

    const storage = resolveStorage(options?.storage);

    if (readStoredClaim(storage, key)) {
        /* Remember it for this load too, so we stop re-reading. */
        claimedInMemory.add(key);
        return false;
    }

    claimedInMemory.add(key);
    writeStoredClaim(storage, key);

    return true;
}

/**
 * Test-only reset of the in-memory claims so module state does not
 * leak between test cases.
 */
export function resetPurchaseClaimsForTests(): void {
    claimedInMemory.clear();
}

/* ==========================================
 * META PURCHASE EVENT ID (CONTRACT ONLY)
 * ==========================================
 *
 * Reserved for the Meta Pixel phase. It is a deterministic id shared
 * with a future server-side Conversions API copy of the same Purchase
 * — it is NOT a browser-side deduplication mechanism, and nothing in
 * this phase calls it.
 */

export const META_PURCHASE_EVENT_ID_PREFIX =
    "meta:purchase";

/**
 * Build `meta:purchase:<orderNumber>`.
 *
 * Deterministic (never random) so a future browser + server pair would
 * produce the exact same string. Contains no secret and no PII: the
 * order number is already shown to the buyer.
 */
export function buildMetaPurchaseEventId(
    orderNumber: string
): string | null {
    const reference = normalizeSegment(orderNumber);

    if (!reference) {
        return null;
    }

    return `${META_PURCHASE_EVENT_ID_PREFIX}:${reference}`;
}
