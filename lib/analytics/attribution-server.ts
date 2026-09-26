import "server-only";

import {
    parseTikTokAttributionCookie,
    type OrderAttributionInput,
} from "@/lib/analytics/attribution";
import { getClientIp } from "@/lib/rate-limit";

/**
 * ==========================================
 * ORDER ATTRIBUTION — CUSTOMER REQUEST BOUNDARY
 * ==========================================
 *
 * Reads the TikTok attribution captured by the browser together
 * with the CUSTOMER'S OWN request metadata at the moment the
 * application creates / updates an order.
 *
 * SECURITY — the customer identity boundary:
 *   - `clientIp` comes from `getClientIp()`, the app's existing
 *     trusted-proxy-aware helper. Without `TRUSTED_PROXY` it
 *     returns "untrusted", which is stored as null rather than a
 *     fake value.
 *   - `clientUserAgent` comes from THIS request's `User-Agent`.
 *   - The iPaymu webhook's IP / User-Agent are NEVER read here and
 *     must never be used as the customer's. The webhook only reads
 *     what was persisted at this boundary.
 *
 * Never logs. Never throws.
 */

/** Trim + bound the request user-agent. */
export function sanitizeClientUserAgent(
    value: unknown
): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const cleaned = value
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim();

    return cleaned ? cleaned.slice(0, 512) : null;
}

/**
 * Resolve the customer IP from the existing IP helper, treating the
 * "untrusted" sentinel as "unknown" (nullable).
 */
export function resolveClientIp(
    request: Request
): string | null {
    const ip = getClientIp(request);

    if (!ip || ip === "untrusted") {
        return null;
    }

    return ip;
}

/**
 * Capture every attribution value available at the application
 * request boundary. All values are nullable.
 */
export function readOrderAttribution(
    request: Request
): OrderAttributionInput {
    const cookieHeader =
        request.headers.get("cookie");

    const attribution =
        parseTikTokAttributionCookie(
            cookieHeader
        );

    return {
        ttclid: attribution?.ttclid ?? null,
        ttp: attribution?.ttp ?? null,
        landingUrl:
            attribution?.landingUrl ?? null,
        referrer:
            attribution?.referrer ?? null,
        clientIp: resolveClientIp(request),
        clientUserAgent:
            sanitizeClientUserAgent(
                request.headers.get("user-agent")
            ),
    };
}
