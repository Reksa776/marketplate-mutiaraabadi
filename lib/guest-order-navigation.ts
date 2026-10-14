/**
 * ==========================================
 * GUEST ORDER RECOVERY — POST-OTP NAVIGATION
 * ==========================================
 *
 * Everything the recovery form needs to decide AFTER a one-time code
 * verifies, kept as pure functions so it can be unit tested without a
 * DOM, a router or a network:
 *
 *   * where a recovered order may be opened (the EXISTING order detail
 *     route — never a new one),
 *   * how the confirm response is read (defensively: a partial body
 *     means "stay put", not "navigate"),
 *   * whether the freshly issued guest cookie really unlocked the order.
 *
 * SECURITY CONTRACT
 *
 *   1. NOTHING SECRET EVER REACHES THE URL. The only value that is
 *      allowed to appear in a redirect is the ORDER ID. The OTP, the
 *      guest access token, the email and the phone number are never
 *      interpolated here — by construction, since the path is built from
 *      a positive integer and a fixed prefix.
 *
 *   2. AUTHENTICATION STAYS IN THE HTTPONLY COOKIE. The token the server
 *      mints on confirm is httpOnly, so JavaScript can neither read it
 *      nor put it in a URL. `isOrderAccessGranted` is how the client
 *      PROVES the cookie works: it asks the ownership-guarded order
 *      detail endpoint, which authorizes from the cookie alone.
 *
 *   3. NO REDIRECT LOOP. A navigation happens only after that proof
 *      succeeded, so the buyer is never sent to a detail page that would
 *      answer "Pesanan tidak ditemukan". A failure is reported in place,
 *      on the page the buyer is already on.
 */

/**
 * The EXISTING guest order detail route (`app/orders/[id]`). Recovery
 * reuses it rather than inventing a second detail surface — one page,
 * one authorization path.
 */
export const ORDER_DETAIL_ROUTE = "/orders";

/** The public tracking page (`app/lacak`). */
export const TRACKING_ROUTE = "/lacak";

/** The guest order history page (`app/orders`), token-scoped. */
export const ORDERS_ROUTE = "/orders";

/**
 * Shown when the code verified but the order still cannot be read with
 * the cookie this browser now holds. The buyer stays on the current page
 * (the code is already consumed, so a retry needs a NEW code) instead of
 * being pushed into a page that would answer "Pesanan tidak ditemukan".
 */
export const RECOVERY_ACCESS_PENDING_MESSAGE =
    "Kode terverifikasi, tetapi akses pesanan belum aktif di perangkat ini. Minta kode baru lalu coba lagi.";

/** Shown when the confirm response carried no usable order reference. */
export const RECOVERY_UNREADABLE_RESULT_MESSAGE =
    "Kode terverifikasi, tetapi detail pesanan tidak dapat dibaca. Minta kode baru lalu coba lagi.";

/** Default success copy, used when the server sends none. */
export const RECOVERY_ACCESS_RESTORED_MESSAGE =
    "Akses pesanan berhasil dipulihkan.";

/**
 * Normalize an order id that arrived over the wire into the positive
 * integer the detail route expects.
 *
 * Accepts a number or a numeric string (an API may serialize either) and
 * rejects everything else — a fractional, zero, negative, NaN or
 * non-numeric value must never be interpolated into a path.
 */
export function normalizeOrderId(value: unknown): number | null {
    /*
     * Only plain digits are accepted from a string. `Number()` would also
     * accept "1e3", "0x10", "  12  " and "Infinity", none of which is an
     * order id — and every one of them would be interpolated straight
     * into a path.
     */
    if (typeof value === "string") {
        const trimmed = value.trim();

        if (!/^\d+$/.test(trimmed)) {
            return null;
        }

        const parsed = Number(trimmed);

        return Number.isSafeInteger(parsed) && parsed > 0
            ? parsed
            : null;
    }

    if (typeof value !== "number") {
        return null;
    }

    if (!Number.isSafeInteger(value) || value <= 0) {
        return null;
    }

    return value;
}

/**
 * The order detail path for a recovered order, or null when the id is
 * unusable.
 *
 * The returned string contains the numeric id and nothing else: no OTP,
 * no guest token, no email and no phone number can flow into it.
 */
export function orderDetailPath(orderId: unknown): string | null {
    const id = normalizeOrderId(orderId);

    if (id === null) {
        return null;
    }

    return `${ORDER_DETAIL_ROUTE}/${id}`;
}

export type RecoveredOrder = {
    id: number;
    /** Empty string when the server did not echo one. */
    orderNumber: string;
};

/**
 * Read the order reference out of the confirm response body.
 *
 * Deliberately defensive: the ONLY requirement is a usable id. A missing
 * order number degrades to an empty string (it is display copy, not an
 * authorization input), while a missing/invalid id yields null so the
 * caller reports the failure instead of navigating nowhere.
 */
export function parseRecoveredOrder(
    data: unknown
): RecoveredOrder | null {
    if (!data || typeof data !== "object") {
        return null;
    }

    const source = data as Record<string, unknown>;

    const id = normalizeOrderId(source.id);

    if (id === null) {
        return null;
    }

    return {
        id,
        orderNumber:
            typeof source.orderNumber === "string"
                ? source.orderNumber.trim()
                : "",
    };
}

/**
 * Did a read of the freshly recovered order actually authorize?
 *
 * This is the check that turns "the confirm endpoint answered 200" into
 * "this browser can really open the order". The order detail endpoint is
 * ownership-guarded (session owner or a valid guest access token for
 * THAT order), answers 404 for anything else, and reads the token from
 * the httpOnly cookie — which is exactly the credential recovery just
 * issued.
 *
 * Fail closed on every shape that is not an explicit success.
 */
export function isOrderAccessGranted(
    response: { ok: boolean; body: unknown } | null
): boolean {
    if (!response || response.ok !== true) {
        return false;
    }

    const body = response.body;

    if (!body || typeof body !== "object") {
        return false;
    }

    return (body as { success?: unknown }).success === true;
}
