import "server-only";

import { buildTikTokEventId } from "@/lib/analytics/tiktok";
import { getTikTokEventsApiConfig } from "@/lib/analytics/tiktok-events-config";

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
 * Guarantees:
 *   - server-only (never bundled to the client)
 *   - reads Pixel ID + Access Token from StoreSetting
 *   - skips the request entirely when disabled / unconfigured
 *   - bounded by a timeout
 *   - NEVER throws (TikTok must never break checkout / payment)
 *   - safe logging: event name + event_id + status/code only —
 *     never the token, the Access-Token header, the request body,
 *     the raw response body, or customer PII
 */
export const TIKTOK_EVENTS_API_URL =
    "https://business-api.tiktok.com/open_api/v1.3/event/track/";

export const TIKTOK_EVENTS_API_TIMEOUT_MS = 3000;

export type TikTokEventContent = {
    content_id: string;
    content_type?: string;
    content_name?: string;
    quantity?: number;
    price?: number;
};

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
    pageUrl?: string;
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
    data: Array<Record<string, unknown>>;
};

function buildPayload(
    pixelId: string,
    input: TikTokServerEventInput
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

    return {
        event_source: "web",
        event_source_id: pixelId,
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
            input
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
        productId?: number | null;
        id?: number;
        productName?: string | null;
        quantity?: number | null;
        price?: unknown;
    }> | null;
};

/**
 * Convenience wrapper: authoritative server-side CompletePayment.
 *
 * Called ONLY from the payment settlement webhooks, after the
 * order has actually transitioned to PAID. Uses a deterministic
 * event_id (`ttq:completepayment:<orderNumber>`) identical to the
 * one the browser Pixel sends, so TikTok deduplicates the two.
 */
export async function trackTikTokServerCompletePayment(
    order: TikTokOrderLike
): Promise<TikTokSendResult> {
    const contents: TikTokEventContent[] = [];

    for (const item of order.items ?? []) {
        const contentId = String(
            item.productId ?? item.id ?? ""
        ).trim();

        if (!contentId) {
            continue;
        }

        contents.push({
            content_id: contentId,
            content_type: "product",
            content_name: item.productName ?? undefined,
            quantity:
                typeof item.quantity === "number"
                    ? item.quantity
                    : undefined,
            price:
                item.price !== undefined &&
                item.price !== null
                    ? Number(item.price)
                    : undefined,
        });
    }

    const value = Number(order.total);

    return sendTikTokEvent({
        event: "CompletePayment",
        eventId: buildTikTokEventId(
            "CompletePayment",
            order.orderNumber
        ),
        value: Number.isFinite(value) ? value : undefined,
        currency: "IDR",
        orderId: order.orderNumber,
        contents,
    });
}
