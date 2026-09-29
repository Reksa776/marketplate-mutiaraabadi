/**
 * ==========================================
 * TIKTOK EVENTS API — STANDALONE DIAGNOSTIC PROBE
 * ==========================================
 *
 * The request/response contract used by
 * `scripts/tiktok-events-api-check.ts`, the script an operator runs
 * as `npx tsx scripts/tiktok-events-api-check.ts` on a server that
 * has no Next.js runtime.
 *
 * ------------------------------------------------------------------
 * WHY THIS IS A SEPARATE MODULE (and not a reuse of the sender)
 * ------------------------------------------------------------------
 * `lib/analytics/tiktok-events-api.ts` is `server-only`, and the
 * `server-only` marker is resolved by the Next.js bundler. Outside
 * that bundler — i.e. under plain Node/tsx — the import cannot even
 * be resolved, so a standalone script can never require it.
 *
 * This module therefore states the SAME verified v1.3 / Events API
 * 2.0 contract on its own, with:
 *
 *   - ZERO imports, so no part of the application (and in
 *     particular nothing marked `server-only`) is pulled in, and
 *   - ZERO customer data: no matching keys, no attribution, no
 *     order data, no PII — a probe event carries nothing that
 *     belongs to a customer.
 *
 * The application implementation is untouched: the probe verifies
 * TikTok's side of the contract, so a drift in either direction is
 * visible instead of hidden.
 *
 * Verified contract (TikTok "Event Track", v1.3 / Events 2.0):
 *   POST https://business-api.tiktok.com/open_api/v1.3/event/track/
 *   Header: Access-Token: <pixel access token>
 *   Body:   { event_source: "web", event_source_id: <pixel id>,
 *             test_event_code?: <code>,           <-- TOP level
 *             data: [{ event, event_time, event_id, properties }] }
 *   Accepted <=> HTTP 2xx AND body `code === 0`.
 */

/** The one endpoint TikTok accepts server events on. */
export const TIKTOK_EVENTS_API_ENDPOINT =
    "https://business-api.tiktok.com/open_api/v1.3/event/track/";

/**
 * Header that carries the (secret) Pixel Access Token.
 *
 * Only the header NAME lives here — the value is supplied by the
 * caller at request time and is never stored, returned or printed
 * by this module.
 */
export const TIKTOK_EVENTS_API_TOKEN_HEADER =
    "Access-Token";

/**
 * Probe timeout. Slightly longer than the application's 3 s so a
 * slow-but-working connection is not reported as a failure.
 */
export const TIKTOK_PROBE_TIMEOUT_MS = 5000;

/** Store currency (IDR only). */
export const TIKTOK_PROBE_CURRENCY = "IDR";

/**
 * Marker every probe reference starts with, so a synthetic event is
 * always recognisable in Events Manager and can never collide with
 * a real order number (`ORD-…` / `PAY-CART-…`).
 */
export const TIKTOK_PROBE_REFERENCE_PREFIX =
    "TIKTOK-DIAGNOSTIC";

/** Event name probed — the same one the settlement path reports. */
export const TIKTOK_PROBE_EVENT_NAME = "CompletePayment";

/** Value reported by a probe, in IDR. Deliberately negligible. */
export const TIKTOK_PROBE_VALUE = 1;

export type TikTokProbePayload = {
    event_source: "web";
    event_source_id: string;
    /** Present ONLY when a test event code is configured. */
    test_event_code?: string;
    data: Array<{
        event: string;
        event_time: number;
        event_id: string;
        properties: {
            value: number;
            currency: string;
            order_id: string;
        };
    }>;
};

export type TikTokProbeResponse = {
    /** Whether the HTTP body was readable JSON at all. */
    readable: boolean;
    code?: number;
    message?: string;
    requestId?: string;
};

/**
 * Unique reference for one probe run.
 *
 * Timestamp + random nonce: every run must produce a NEW reference,
 * because TikTok deduplicates events sharing the same
 * `event_source_id` + event name + `event_id` (it keeps the first
 * one and discards later copies for 48 hours). A probe that reused
 * an id would appear to "fail" simply because the browser Pixel
 * already sent a CompletePayment for that reference.
 */
export function buildTikTokProbeReference(
    now: number = Date.now(),
    nonce: number = Math.floor(
        Math.random() * 1_000_000
    )
): string {
    return `${TIKTOK_PROBE_REFERENCE_PREFIX}-${now}-${nonce}`;
}

/**
 * Deduplication id for the probe.
 *
 * Same deterministic shape as the application's CompletePayment
 * event id (`ttq:completepayment:<reference>`), but the reference is
 * synthetic and unique, so it can never deduplicate against a real
 * conversion.
 */
export function buildTikTokProbeEventId(
    reference: string
): string {
    return `ttq:completepayment:${reference}`;
}

/**
 * Build the probe request body.
 *
 * Contains NO customer identifiers, NO hashed matching keys and NO
 * attribution — a probe must never look like a customer event.
 */
export function buildTikTokProbePayload(input: {
    pixelId: string;
    reference: string;
    eventId: string;
    testEventCode: string | null;
    eventTime?: Date;
}): TikTokProbePayload {
    return {
        event_source: "web",
        event_source_id: input.pixelId,
        /*
         * Top level, exactly where TikTok reads it — not inside
         * data[] and not inside properties.
         */
        ...(input.testEventCode
            ? {
                  test_event_code:
                      input.testEventCode,
              }
            : {}),
        data: [
            {
                event: TIKTOK_PROBE_EVENT_NAME,
                event_time: Math.floor(
                    (
                        input.eventTime ??
                        new Date()
                    ).getTime() / 1000
                ),
                event_id: input.eventId,
                properties: {
                    value: TIKTOK_PROBE_VALUE,
                    currency:
                        TIKTOK_PROBE_CURRENCY,
                    order_id: input.reference,
                },
            },
        ],
    };
}

/**
 * Read TikTok's response body defensively.
 *
 * A non-JSON body (HTML error page, proxy response, empty body) is
 * reported as `readable: false` rather than collapsed into
 * "code: undefined", which is the difference between "TikTok
 * rejected us" and "something in between answered".
 */
export function readTikTokProbeResponse(
    body: unknown
): TikTokProbeResponse {
    if (!body || typeof body !== "object") {
        return { readable: false };
    }

    const record = body as {
        code?: unknown;
        message?: unknown;
        request_id?: unknown;
    };

    return {
        readable: true,
        code:
            typeof record.code === "number"
                ? record.code
                : undefined,
        message:
            typeof record.message === "string"
                ? record.message
                : undefined,
        requestId:
            typeof record.request_id === "string"
                ? record.request_id
                : undefined,
    };
}

/**
 * The application's acceptance rule, applied to a probe response:
 * HTTP 2xx AND a top-level `code` of 0 ("OK").
 */
export function isTikTokProbeAccepted(
    status: number,
    response: TikTokProbeResponse
): boolean {
    return (
        status >= 200 &&
        status < 300 &&
        response.code === 0
    );
}

/**
 * The ONLY thing a probe run may print.
 *
 * Built from non-sensitive inputs only (never the access token, the
 * test event code value, an identifier, or a request/response
 * body), so nothing a report contains can leak a secret.
 */
export function buildTikTokProbeReport(input: {
    reference: string;
    eventId: string;
    accepted: boolean;
    status: number;
    response: TikTokProbeResponse;
    testEventCodeConfigured: boolean;
}): Record<string, unknown> {
    return {
        event: TIKTOK_PROBE_EVENT_NAME,
        endpoint: TIKTOK_EVENTS_API_ENDPOINT,
        reference: input.reference,
        eventId: input.eventId,
        accepted: input.accepted,
        status: input.status,
        code: input.response.code,
        message: input.response.message,
        requestId: input.response.requestId,
        bodyReadable: input.response.readable,
        testEventCodeConfigured:
            input.testEventCodeConfigured,
    };
}
