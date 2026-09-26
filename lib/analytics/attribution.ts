/**
 * ==========================================
 * TIKTOK ATTRIBUTION (ttclid / _ttp / landing / referrer)
 * ==========================================
 *
 * Captures TikTok click attribution at the *customer browser*
 * boundary and persists it in a FIRST-PARTY cookie so it survives
 * navigation and is available when the order is created.
 *
 * WHY A FIRST-PARTY COOKIE:
 *   - the value must survive client-side navigation (SPA) and the
 *     transition to checkout / order creation
 *   - it is read by the SERVER on order creation (request cookies)
 *     and then stored on the Order row
 *   - it is deliberately NOT httpOnly-neutral or a server-generated
 *     `_ttp`: `_ttp` is TikTok's own cookie. We only ever READ it
 *     when the browser has it; we never fabricate it.
 *
 * This module is intentionally NOT `server-only`: the capture runs
 * in the browser and the parse/serialize helpers are also used by
 * server route handlers. It contains NO secret and never logs.
 */

/** First-party cookie holding the captured attribution. */
export const TIKTOK_ATTRIBUTION_COOKIE = "tt_attr";

/** 30 days, matching typical ad-click attribution windows. */
export const TIKTOK_ATTRIBUTION_MAX_AGE_SECONDS =
    60 * 60 * 24 * 30;

/** Upper bounds so a hostile value can never bloat a cookie / row. */
export const MAX_TIKTOK_TTCLID_LENGTH = 512;
export const MAX_TIKTOK_TTP_LENGTH = 512;
export const MAX_TIKTOK_ATTRIBUTION_URL_LENGTH = 2048;

/**
 * Attribution captured from the browser. Every field is nullable:
 * traffic that did not originate from TikTok legitimately has no
 * ttclid / _ttp.
 */
export type TikTokAttribution = {
    /** TikTok click id from the landing URL (`?ttclid=...`). */
    ttclid: string | null;
    /** TikTok's own `_ttp` cookie value, when the browser has it. */
    ttp: string | null;
    /** First landing URL of this visit. */
    landingUrl: string | null;
    /** First referrer of this visit. */
    referrer: string | null;
    /** Capture time (ms). */
    capturedAt: number;
};

/** Attribution persisted on an Order at creation time. */
export type OrderAttributionInput = {
    ttclid?: string | null;
    ttp?: string | null;
    landingUrl?: string | null;
    referrer?: string | null;
    /** Customer request IP (application boundary, never the webhook). */
    clientIp?: string | null;
    /** Customer request user-agent (never the webhook's). */
    clientUserAgent?: string | null;
};

/** Remove control characters that have no place in a cookie value. */
function stripControlCharacters(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f]/g, "");
}

/** Trim + bound an opaque id (ttclid / _ttp). */
export function sanitizeTikTokAttributionToken(
    value: unknown,
    maxLength: number
): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const token = stripControlCharacters(value).trim();

    if (!token) {
        return null;
    }

    return token.slice(0, maxLength);
}

/** Only absolute http(s) URLs are persisted; everything else is dropped. */
export function sanitizeTikTokAttributionUrl(
    value: unknown
): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const url = stripControlCharacters(value).trim();

    if (!url) {
        return null;
    }

    if (
        !url.startsWith("http://") &&
        !url.startsWith("https://")
    ) {
        return null;
    }

    return url.slice(
        0,
        MAX_TIKTOK_ATTRIBUTION_URL_LENGTH
    );
}

/** Read `ttclid` from a URL search string (with or without `?`). */
export function readTikTokClickIdFromSearch(
    search: string
): string | null {
    if (!search) {
        return null;
    }

    try {
        const params = new URLSearchParams(
            search.startsWith("?")
                ? search.slice(1)
                : search
        );

        return sanitizeTikTokAttributionToken(
            params.get("ttclid"),
            MAX_TIKTOK_TTCLID_LENGTH
        );
    } catch {
        return null;
    }
}

/**
 * Extract a cookie value from a `document.cookie` / `Cookie` header
 * string. Returns null when the cookie is absent.
 */
export function readCookieValue(
    cookieString: string | null | undefined,
    name: string
): string | null {
    if (!cookieString) {
        return null;
    }

    for (const part of cookieString.split(";")) {
        const separator = part.indexOf("=");

        if (separator === -1) {
            continue;
        }

        const key = part.slice(0, separator).trim();

        if (key === name) {
            return part.slice(separator + 1).trim();
        }
    }

    return null;
}

/** Read TikTok's own `_ttp` cookie value, when present. */
export function readTtpFromCookieString(
    cookieString: string | null | undefined
): string | null {
    return sanitizeTikTokAttributionToken(
        readCookieValue(cookieString, "_ttp"),
        MAX_TIKTOK_TTP_LENGTH
    );
}

/** Parse the first-party attribution cookie (tolerates corruption). */
export function parseTikTokAttributionCookie(
    cookieString: string | null | undefined
): TikTokAttribution | null {
    const raw = readCookieValue(
        cookieString,
        TIKTOK_ATTRIBUTION_COOKIE
    );

    if (!raw) {
        return null;
    }

    let decoded: string;

    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return null;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(decoded);
    } catch {
        return null;
    }

    if (
        !parsed ||
        typeof parsed !== "object"
    ) {
        return null;
    }

    const record = parsed as Record<
        string,
        unknown
    >;

    const attribution: TikTokAttribution = {
        ttclid: sanitizeTikTokAttributionToken(
            record.ttclid,
            MAX_TIKTOK_TTCLID_LENGTH
        ),
        ttp: sanitizeTikTokAttributionToken(
            record.ttp,
            MAX_TIKTOK_TTP_LENGTH
        ),
        landingUrl: sanitizeTikTokAttributionUrl(
            record.landingUrl
        ),
        referrer: sanitizeTikTokAttributionUrl(
            record.referrer
        ),
        capturedAt:
            typeof record.capturedAt === "number" &&
            Number.isFinite(record.capturedAt)
                ? record.capturedAt
                : 0,
    };

    return attribution;
}

/** Serialize attribution into the first-party cookie value. */
export function serializeTikTokAttributionCookie(
    attribution: TikTokAttribution
): string {
    return encodeURIComponent(
        JSON.stringify(attribution)
    );
}

/**
 * Merge a freshly-observed attribution into an existing one.
 *
 * The FIRST non-empty ttclid / landingUrl / referrer wins: the
 * earliest touch is the ad click we want to attribute. `_ttp` is
 * refreshed from the browser cookie whenever available because
 * TikTok rotates it.
 */
export function mergeTikTokAttribution(
    existing: TikTokAttribution | null,
    incoming: Partial<TikTokAttribution>
): TikTokAttribution {
    return {
        ttclid:
            existing?.ttclid ??
            incoming.ttclid ??
            null,
        ttp:
            incoming.ttp ??
            existing?.ttp ??
            null,
        landingUrl:
            existing?.landingUrl ??
            incoming.landingUrl ??
            null,
        referrer:
            existing?.referrer ??
            incoming.referrer ??
            null,
        capturedAt:
            existing?.capturedAt ||
            incoming.capturedAt ||
            Date.now(),
    };
}

/**
 * Read the current attribution from a live browser and persist it.
 *
 * Returns null outside a browser. Never throws (attribution must
 * never break a page).
 */
export function captureTikTokAttributionFromBrowser():
    | TikTokAttribution
    | null {
    if (
        typeof window === "undefined" ||
        typeof document === "undefined"
    ) {
        return null;
    }

    try {
        const existing =
            parseTikTokAttributionCookie(
                document.cookie
            );

        const next = mergeTikTokAttribution(
            existing,
            {
                ttclid: readTikTokClickIdFromSearch(
                    window.location.search
                ),
                ttp: readTtpFromCookieString(
                    document.cookie
                ),
                landingUrl:
                    sanitizeTikTokAttributionUrl(
                        window.location.href
                    ),
                referrer:
                    sanitizeTikTokAttributionUrl(
                        document.referrer
                    ),
                capturedAt: Date.now(),
            }
        );

        // Only rewrite the cookie when something actually changed.
        if (
            !existing ||
            existing.ttclid !== next.ttclid ||
            existing.ttp !== next.ttp ||
            existing.landingUrl !==
                next.landingUrl ||
            existing.referrer !==
                next.referrer
        ) {
            persistTikTokAttribution(next);
        }

        return next;
    } catch {
        return null;
    }
}

/** Write the attribution cookie. Browser-only, never throws. */
export function persistTikTokAttribution(
    attribution: TikTokAttribution
): void {
    if (typeof document === "undefined") {
        return;
    }

    try {
        document.cookie =
            `${TIKTOK_ATTRIBUTION_COOKIE}=` +
            `${serializeTikTokAttributionCookie(
                attribution
            )}; path=/; max-age=` +
            `${TIKTOK_ATTRIBUTION_MAX_AGE_SECONDS}; ` +
            `SameSite=Lax`;
    } catch {
        /* Best-effort: a blocked cookie never breaks the page. */
    }
}
