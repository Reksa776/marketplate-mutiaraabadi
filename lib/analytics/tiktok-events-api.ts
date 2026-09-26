import "server-only";

import { buildTikTokEventId } from "@/lib/analytics/tiktok";
import {
    TIKTOK_CURRENCY,
    buildTikTokContents,
    toTikTokAmount,
    type TikTokCatalogContent,
} from "@/lib/analytics/tiktok-catalog";
import { getTikTokEventsApiConfig } from "@/lib/analytics/tiktok-events-config";
import {
    buildTikTokUserMatch,
    hasTikTokUserMatch,
    type TikTokUserMatch,
} from "@/lib/analytics/tiktok-user-match";

/**
 * ==========================================
 * TIKTOK EVENTS API — SERVER SERVICE
 * ==========================================
 *
 * Single, central place that talks to TikTok's Events API
 * (server-to-server). No other module may `fetch()` TikTok.
 *
 * API contract (verified against TikTok's Events API 2.0):
 *   POST https://business-api.tiktok.com/open_api/v1.3/event/track/
 *   Header: Access-Token: <token>
 *   Body:   { event_source: "web", event_source_id: <pixel id>,
 *             data: [{ event, event_time, event_id, properties, ... }] }
 *   Response: JSON with `code` (0 = accepted).
 *
 * Test mode (opt-in):
 *   When TIKTOK_TEST_EVENT_CODE is set, the SAME request also
 *   carries the top-level field `test_event_code`, which routes
 *   the event to the TikTok Events Manager "Test Events" view.
 *   It does NOT change the event name, the event_id, the
 *   properties, the endpoint, the Access-Token header, or any
 *   settlement/database behaviour — it only adds one field, and
 *   only while the environment variable is present.
 *
 * Guarantees:
 *   - server-only (never bundled to the client)
 *   - reads Pixel ID + Access Token from StoreSetting
 *   - skips the request entirely when disabled / unconfigured
 *   - bounded by a timeout
 *   - NEVER throws (TikTok must never break checkout / payment)
 *   - safe logging: event name + event_id + status/code only —
 *     never the token, the Access-Token header, the request body,
 *     the raw response body, or customer PII
 *
 * Advanced Matching (privacy-safe):
 *   When the caller passes RAW customer identifiers, they are
 *   normalized + SHA-256 hashed by lib/analytics/tiktok-user-match
 *   and sent as `data[].user`. Raw email / phone never reach the
 *   request body, the logs, or TikTok. Missing or invalid values
 *   are omitted entirely — no empty strings, no fabricated keys.
 */
export const TIKTOK_EVENTS_API_URL =
    "https://business-api.tiktok.com/open_api/v1.3/event/track/";

export const TIKTOK_EVENTS_API_TIMEOUT_MS = 3000;

export type TikTokEventContent = TikTokCatalogContent;

export type TikTokServerEventInput = {
    /** Standard TikTok event name, e.g. "CompletePayment". */
    event: string;

    /** Dedup key shared with the browser Pixel. */
    eventId: string;

    /** When the event happened (defaults to now). */
    eventTime?: Date;

    value?: number;
    currency?: string;
    orderId?: string;
    contents?: TikTokEventContent[];
    pageUrl?: string | null;

    /**
     * Customer attribution captured at the APPLICATION request
     * boundary (never the payment webhook's own IP / UA). All are
     * sent unhashed inside `data[].user`.
     */
    ttclid?: string | null;
    ttp?: string | null;
    ip?: string | null;
    userAgent?: string | null;

    /**
     * ALREADY-HASHED Advanced Matching keys (`email`, `phone`,
     * `external_id`). Built by lib/analytics/tiktok-user-match —
     * this module never receives, hashes, or logs raw PII.
     * Omitted entirely when empty.
     */
    user?: TikTokUserMatch;
};

export type TikTokSendResult = {
    ok: boolean;
    skipped: boolean;
    reason?: string;
    status?: number;
    code?: number;
    message?: string;
};

type TikTokEventPayload = {
    event_source: "web";
    event_source_id: string;
    /**
     * Present ONLY in test mode (TIKTOK_TEST_EVENT_CODE set).
     * TikTok reads it at the top level of the request, NOT
     * inside data[] or properties.
     */
    test_event_code?: string;
    data: Array<Record<string, unknown>>;
};

function buildPayload(
    pixelId: string,
    input: TikTokServerEventInput,
    testEventCode: string | null = null
): TikTokEventPayload {
    const properties: Record<string, unknown> = {};

    if (typeof input.value === "number" && Number.isFinite(input.value)) {
        properties.value = input.value;
    }

    if (input.currency) {
        properties.currency = input.currency;
    }

    if (input.orderId) {
        properties.order_id = input.orderId;
    }

    if (input.contents && input.contents.length > 0) {
        properties.content_type = "product";
        properties.contents = input.contents;
    }

    const event: Record<string, unknown> = {
        event: input.event,
        event_time: Math.floor(
            (input.eventTime ?? new Date()).getTime() / 1000
        ),
        event_id: input.eventId,
    };

    if (Object.keys(properties).length > 0) {
        event.properties = properties;
    }

    if (input.pageUrl) {
        event.page = { url: input.pageUrl };
    }

    /*
     * `data[].user` carries the Advanced Matching keys (hashed)
     * plus the attribution identifiers (unhashed). Attached only
     * when at least one usable value exists, so an event for an
     * anonymous visitor carries no user object at all instead of
     * an empty one.
     */
    const user: Record<string, unknown> = {
        ...(hasTikTokUserMatch(input.user)
            ? input.user
            : {}),
    };

    if (input.ttclid) {
        user.ttclid = input.ttclid;
    }

    if (input.ttp) {
        user.ttp = input.ttp;
    }

    if (input.ip) {
        user.ip = input.ip;
    }

    if (input.userAgent) {
        user.user_agent = input.userAgent;
    }

    if (Object.keys(user).length > 0) {
        event.user = user;
    }

    return {
        event_source: "web",
        event_source_id: pixelId,
        /*
         * Test mode tag: spread only when configured, so the
         * default (production) body is byte-for-byte what it
         * was before this feature existed.
         */
        ...(testEventCode
            ? { test_event_code: testEventCode }
            : {}),
        data: [event],
    };
}

/**
 * Send one event to the TikTok Events API.
 *
 * Non-throwing by contract: every failure resolves to a result
 * object so callers can treat tracking as a best-effort side
 * effect.
 */
export async function sendTikTokEvent(
    input: TikTokServerEventInput
): Promise<TikTokSendResult> {
    try {
        const config =
            await getTikTokEventsApiConfig();

        /*
         * Fail closed: nothing to send without an enabled
         * pixel, a Pixel ID, and an Access Token.
         */
        if (!config.enabled) {
            return {
                ok: false,
                skipped: true,
                reason: "pixel_disabled",
            };
        }

        if (!config.pixelId) {
            return {
                ok: false,
                skipped: true,
                reason: "missing_pixel_id",
            };
        }

        if (!config.accessToken) {
            return {
                ok: false,
                skipped: true,
                reason: "missing_access_token",
            };
        }

        const payload = buildPayload(
            config.pixelId,
            input,
            config.testEventCode
        );

        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            TIKTOK_EVENTS_API_TIMEOUT_MS
        );

        let response: Response;

        try {
            response = await fetch(
                TIKTOK_EVENTS_API_URL,
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                        /* SECRET — never logged. */
                        "Access-Token":
                            config.accessToken,
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                    cache: "no-store",
                }
            );
        } finally {
            clearTimeout(timeout);
        }

        let parsed: {
            code?: unknown;
            message?: unknown;
        } | null = null;

        try {
            parsed = (await response.json()) as {
                code?: unknown;
                message?: unknown;
            };
        } catch {
            parsed = null;
        }

        const code =
            typeof parsed?.code === "number"
                ? parsed.code
                : undefined;

        const message =
            typeof parsed?.message === "string"
                ? parsed.message
                : undefined;

        const ok =
            response.ok && code === 0;

        if (!ok) {
            /*
             * Safe diagnostics only: no token, no header, no
             * request/response body.
             */
            console.error(
                "[TIKTOK EVENTS API] event not accepted",
                {
                    event: input.event,
                    eventId: input.eventId,
                    status: response.status,
                    code,
                    message,
                }
            );
        }

        return {
            ok,
            skipped: false,
            status: response.status,
            code,
            message,
        };
    } catch (error) {
        /*
         * Timeout (AbortError), network error, JSON error — all
         * swallowed. Tracking must never propagate an error.
         */
        console.error(
            "[TIKTOK EVENTS API] request failed",
            {
                event: input.event,
                eventId: input.eventId,
                reason:
                    error instanceof Error
                        ? error.name
                        : "unknown",
            }
        );

        return {
            ok: false,
            skipped: false,
            reason: "request_failed",
        };
    }
}

type TikTokOrderLike = {
    orderNumber: string;
    total: unknown;
    items?: Array<{
        id?: number;
        productId?: number | null;
        variantId?: number | null;
        /** Future-proof: used as content_id the moment a SKU exists. */
        sku?: string | null;
        productName?: string | null;
        variantName?: string | null;
        quantity?: number | null;
        price?: unknown;
    }> | null;
    /** RAW — hashed inside this call, never logged nor forwarded. */
    email?: string | null;
    /** RAW — hashed inside this call, never logged nor forwarded. */
    phone?: string | null;
    /** Stable internal customer id, used as hashed external_id. */
    userId?: string | null;

    /*
     * Attribution persisted on the Order at the customer request
     * boundary. `pageUrl` is the stored landing URL. Sent unhashed.
     */
    ttclid?: string | null;
    ttp?: string | null;
    pageUrl?: string | null;
    ip?: string | null;
    userAgent?: string | null;
};

/**
 * Convenience wrapper: authoritative server-side CompletePayment.
 *
 * Called ONLY from the payment settlement webhooks, after the
 * order has actually transitioned to PAID. Uses a deterministic
 * event_id (`ttq:completepayment:<orderNumber>`) identical to the
 * one the browser Pixel sends, so TikTok deduplicates the two.
 *
 * Every figure comes from the AUTHORITATIVE database row (order
 * total, order item unit price + quantity) — nothing is recomputed
 * from floating point arithmetic here.
 *
 * Matching keys: the raw email / phone handed in by the webhook are
 * hashed immediately; when the order has neither, the user object
 * is omitted and the event is still sent.
 */
export async function trackTikTokServerCompletePayment(
    order: TikTokOrderLike
): Promise<TikTokSendResult> {
    const contents = buildTikTokContents(
        (order.items ?? []).map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            sku: item.sku,
            productName: item.productName,
            variantName: item.variantName,
            quantity: item.quantity,
            price: item.price,
        }))
    );

    const value = toTikTokAmount(order.total);

    return sendTikTokEvent({
        event: "CompletePayment",
        eventId: buildTikTokEventId(
            "CompletePayment",
            order.orderNumber
        ),
        value,
        currency: TIKTOK_CURRENCY,
        orderId: order.orderNumber,
        contents,
        /*
         * Trusted customer attribution persisted at the application
         * request boundary. Never the settlement webhook's own
         * IP / User-Agent.
         */
        ttclid: order.ttclid ?? null,
        ttp: order.ttp ?? null,
        pageUrl: order.pageUrl ?? null,
        ip: order.ip ?? null,
        userAgent: order.userAgent ?? null,
        /*
         * Raw identifiers go straight into the hashing helper and
         * are never stored, returned, or logged.
         */
        user: buildTikTokUserMatch({
            email: order.email,
            phone: order.phone,
            externalId: order.userId,
        }),
    });
}
