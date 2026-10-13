import type { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * CHECKOUT IDEMPOTENCY
 * ==========================================
 *
 * Guests have no `cleanupPendingCheckoutOrders(userId)` safety net
 * (that helper is keyed on userId), so a double-clicked / retried
 * checkout could otherwise create two PENDING orders and two provider
 * payment instructions.
 *
 * A caller-supplied idempotency key is persisted on `Order.idempotencyKey`
 * (UNIQUE). A duplicate submission collides on the unique index instead
 * of creating a second order, and the original order is returned.
 *
 * The key is OPAQUE and is never used as an authorization credential —
 * it only deduplicates. It is scoped by a prefix the server derives
 * from the guest scope so one guest cannot replay another guest's key.
 */

const MAX_KEY_LENGTH = 128;

/** Accept only conservative, opaque keys. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Extract a candidate idempotency key from the request header or body.
 * Returns null when absent/invalid — checkout then proceeds without
 * deduplication (rate limiting still applies).
 */
export function readIdempotencyKey(
    request: Request,
    body?: Record<string, unknown> | null
): string | null {
    const fromHeader = request.headers.get(
        "idempotency-key"
    );

    const fromBody =
        typeof body?.idempotencyKey ===
        "string"
            ? (body.idempotencyKey as string)
            : null;

    const candidate = (fromHeader ?? fromBody)?.trim();

    if (!candidate) {
        return null;
    }

    if (
        candidate.length > MAX_KEY_LENGTH ||
        !KEY_PATTERN.test(candidate)
    ) {
        return null;
    }

    return candidate;
}

/**
 * Namespace an idempotency key to its owning scope so keys are not
 * globally interchangeable between guests.
 */
export function scopeIdempotencyKey(
    scope: string,
    rawKey: string
): string {
    return `${scope}:${rawKey}`;
}

/**
 * Look up a previously-created order for this exact idempotency key.
 * Returns null when this is a first submission.
 */
export async function findOrderByIdempotencyKey(
    idempotencyKey: string
) {
    return prisma.order.findUnique({
        where: { idempotencyKey },
        include: { items: true },
    });
}

/* ==========================================
 * ORIGIN / CSRF GUARD
 * ==========================================
 *
 * Guest-facing state-changing endpoints authenticate with COOKIES (the
 * cart token and the guest order token). Cookies are attached by the
 * browser automatically, which is exactly the CSRF threat model.
 *
 * SameSite=Lax already blocks cross-site POSTs in modern browsers;
 * this is the documented defense-in-depth second layer for the
 * endpoints that create orders / spend money.
 *
 * Behaviour:
 *  - When an `Origin`/`Sec-Fetch-Site` header IS present, it must match
 *    this deployment. A mismatch is rejected.
 *  - When NEITHER is present (older/embedded clients, server-to-server
 *    callers), the request is allowed to proceed — the endpoints still
 *    require a valid guest token or session, and rate limiting applies.
 */

export function isSameOriginRequest(
    request: Request
): boolean {
    const secFetchSite = request.headers.get(
        "sec-fetch-site"
    );

    if (secFetchSite) {
        if (secFetchSite === "same-origin") {
            return true;
        }

        /*
         * "none" = direct navigation / non-browser client. Rejecting it
         * would break legitimate programmatic callers that pass no
         * cookies anyway; the cookie requirement still gates them.
         */
        if (secFetchSite === "none") {
            return true;
        }

        return false;
    }

    const origin = request.headers.get("origin");

    if (!origin) {
        return true;
    }

    const host =
        request.headers.get("x-forwarded-host") ??
        request.headers.get("host");

    if (!host) {
        return false;
    }

    try {
        const originUrl = new URL(origin);

        return originUrl.host === host;
    } catch {
        return false;
    }
}

/**
 * Reject cross-site state-changing requests with a 403.
 * Returns a response to short-circuit with, or null when allowed.
 */
export function rejectCrossSite(
    request: Request
): NextResponse | null {
    if (isSameOriginRequest(request)) {
        return null;
    }

    return Response.json(
        {
            success: false,
            message: "Permintaan lintas situs ditolak.",
        },
        { status: 403 }
    ) as unknown as NextResponse;
}
