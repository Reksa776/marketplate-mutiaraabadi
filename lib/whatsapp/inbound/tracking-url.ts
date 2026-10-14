/**
 * ==========================================================
 * WHATSAPP AUTO-REPLY — OFFICIAL TRACKING PAGE LINK (PURE)
 * ==========================================================
 *
 * Builds the ONE url the bot may send a customer:
 *
 *     https://<official origin>/lacak?pesanan=ORD-…
 *
 * WHAT THE URL MAY AND MAY NOT CARRY
 *
 *   * `pesanan` is a PREFILL HINT for the tracking page form. It is
 *     never proof of ownership: the page still gets its data only from
 *     the guest access token cookie or the two-phase OTP recovery, so a
 *     forwarded link grants nothing.
 *   * No guest access token, no OTP, no cookie value, no hash, no
 *     payment reference, no order id, no phone number and no address is
 *     ever put in the query string — a link travels through chat
 *     history, screenshots and WhatsApp's own link preview.
 *
 * FAIL CLOSED
 *
 *   No usable `NEXT_PUBLIC_APP_URL` (missing, unparseable, not in the
 *   official host allowlist, or plain http on a public host) → the
 *   function returns null and the caller keeps its previous text-only
 *   reply. A wrong or attacker-supplied origin must never become a link
 *   in a customer's chat.
 *
 * The module is pure (no database, no network, no Baileys) so every rule
 * below is unit testable.
 */

import { getAllowedAppHosts } from "@/lib/app-origin";

import { isOrderNumberToken } from "./parse";

/** Path of the public tracking page (see app/lacak/page.tsx). */
export const TRACKING_PAGE_PATH = "/lacak";

/** Query parameter carrying the order-number prefill hint. */
export const TRACKING_ORDER_PARAM = "pesanan";

/** The single env var the storefront origin comes from. */
export const TRACKING_URL_ENV = "NEXT_PUBLIC_APP_URL";

/**
 * Hosts on which plain http is tolerated. Development only: the origin
 * is not reachable by a customer's phone anyway, and the production
 * storefront is HTTPS.
 */
const LOOPBACK_HOSTS = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
]);

/**
 * Upper bound on a prefill value. Order numbers are ~30 characters; the
 * cap keeps a hostile long value from bloating the url. Mirrors
 * `TRACKING_PREFILL_MAX_LENGTH` in lib/tracking/tracking-page.ts, which
 * applies the same rule when the page READS the parameter back.
 */
export const TRACKING_PREFILL_MAX_LENGTH = 40;

/**
 * May this value be attached to the link as a prefill hint?
 *
 * Two independent gates: the project's own order-number SHAPE
 * (`isOrderNumberToken`) and a strict charset/length check, so a value
 * carrying url syntax ("#", "&", "?") or anything odd is dropped
 * instead of being percent-encoded into the query string. The handler
 * only ever passes a number that a database lookup resolved, which makes
 * this pure defence in depth.
 */
export function isPrefillOrderNumber(
    value: unknown
): boolean {
    if (typeof value !== "string") {
        return false;
    }

    const trimmed = value.trim();

    if (
        !trimmed ||
        trimmed.length > TRACKING_PREFILL_MAX_LENGTH
    ) {
        return false;
    }

    if (!/^[A-Za-z0-9-]+$/.test(trimmed)) {
        return false;
    }

    return isOrderNumberToken(trimmed);
}

/** How often a missing/invalid base url is logged (never per message). */
export const TRACKING_URL_WARNING_INTERVAL_MS = 5 * 60 * 1000;

let lastWarningAt = 0;

/** Test hook. */
export function resetTrackingUrlWarningThrottle(): void {
    lastWarningAt = 0;
}

/**
 * Resolve the official origin, or null when it cannot be trusted.
 *
 * The host is checked against the SAME allowlist the payment callback
 * origin uses (`lib/app-origin.ts`), so there is exactly one list of
 * domains the application considers its own.
 */
export function resolveTrackingBaseUrl(
    env: Record<string, string | undefined> = process.env
): string | null {
    const raw = env?.[TRACKING_URL_ENV];

    if (typeof raw !== "string" || !raw.trim()) {
        return null;
    }

    let url: URL;

    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }

    const host = url.hostname.toLowerCase();

    if (!getAllowedAppHosts().has(host)) {
        return null;
    }

    if (url.protocol === "https:") {
        return url.origin;
    }

    /*
     * `http:` is accepted for loopback only — a plain-http public host
     * would make the tracking page (and its access-token cookie)
     * interceptable, so it is refused instead of silently downgraded.
     */
    if (url.protocol === "http:" && LOOPBACK_HOSTS.has(host)) {
        return url.origin;
    }

    return null;
}

/**
 * Build the tracking url for one origin.
 *
 * `orderNumber` is only appended when it has the shape this project
 * generates (`isOrderNumberToken`), so a value that is not an order
 * number — or a hostile one — cannot be reflected into the link.
 */
export function buildTrackingLink(input: {
    baseUrl: string;
    orderNumber?: string | null;
}): string {
    const base = String(input.baseUrl ?? "").replace(/\/+$/, "");

    const orderNumber =
        typeof input.orderNumber === "string"
            ? input.orderNumber.trim()
            : "";

    const page = `${base}${TRACKING_PAGE_PATH}`;

    if (!isPrefillOrderNumber(orderNumber)) {
        return page;
    }

    return `${page}?${TRACKING_ORDER_PARAM}=${encodeURIComponent(
        orderNumber
    )}`;
}

/**
 * The url the bot should send, or null when it must stay text-only.
 *
 * Callers pass an order number ONLY after the sender's number has been
 * matched against the order (see handler.ts `bindOrder`); unverified
 * paths call it with no argument and get the bare page link.
 */
export function buildOrderTrackingUrl(
    orderNumber?: string | null,
    env: Record<string, string | undefined> = process.env
): string | null {
    const baseUrl = resolveTrackingBaseUrl(env);

    if (!baseUrl) {
        warnBaseUrlUnavailable();

        return null;
    }

    return buildTrackingLink({ baseUrl, orderNumber });
}

/**
 * Log the misconfiguration at most once per interval.
 *
 * Deliberately without the raw value: the URL itself is not a secret,
 * but nothing here should ever become a place a configuration value is
 * echoed.
 */
function warnBaseUrlUnavailable(): void {
    const now = Date.now();

    if (now - lastWarningAt < TRACKING_URL_WARNING_INTERVAL_MS) {
        return;
    }

    lastWarningAt = now;

    console.warn(
        `[WHATSAPP BOT] Tracking page link disabled: ${TRACKING_URL_ENV} is missing, unparseable, not an allowed origin, or plain http on a public host. Replies fall back to text only.`
    );
}
