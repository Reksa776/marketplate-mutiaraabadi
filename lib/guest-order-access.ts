import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
    getClientIp,
    guestIpKey,
    rateLimiters,
} from "@/lib/rate-limit";
import {
    buildGuestOrderCookieValue,
    generateGuestAccessToken,
    guestAccessTokenExpiry,
    guestOrderCookieName,
    GUEST_ORDER_COOKIE_MAX_AGE_S,
    GUEST_ORDER_COOKIE_PREFIX,
    hashGuestAccessToken,
    isGuestTokenValid,
    normalizeEmail,
    normalizePhone,
    parseGuestOrderCookieValue,
} from "@/lib/guest-identity";

/**
 * ==========================================
 * GUEST ORDER ACCESS
 * ==========================================
 *
 * CRITICAL: an order id or an order number must NEVER be sufficient to
 * read or mutate an order. `Order.id` is a sequential auto-increment
 * integer, so it is trivially enumerable.
 *
 * ACCESS IS GRANTED BY EXACTLY ONE OF:
 *   1. SESSION OWNERSHIP — the authenticated customer owns the order
 *      (legacy orders placed before guest checkout).
 *   2. GUEST TOKEN — a `<orderId>.<rawToken>` httpOnly cookie whose
 *      SHA-256 matches `Order.guestAccessTokenHash` AND whose
 *      server-side window (`Order.guestAccessTokenExpiresAt`, 30 days)
 *      has not passed. The token is 256 bits of CSPRNG output and is
 *      stored ONLY as a hash. An EXPIRED token is refused even when the
 *      browser still sends the cookie — the cookie's maxAge is a
 *      client-side hint, never an authorization decision. The buyer is
 *      not locked out: the order is preserved and the OTP recovery flow
 *      (/api/orders/recover) issues a fresh token after proving
 *      ownership.
 *   3. SECOND FACTOR — orderNumber + the email OR phone captured at
 *      checkout, for buyers who lost their cookie / used another
 *      device. Strictly rate limited by the caller and only usable
 *      via the explicit lookup endpoint (never per-order endpoints),
 *      and it only produces a new token after an OTP is verified.
 *
 * Tokens are never logged, never placed in analytics payloads, and the
 * cookie is httpOnly + SameSite=Lax (+ Secure over HTTPS).
 */

export type AccessDecision =
    | { ok: true; via: "SESSION" | "TOKEN" | "SECOND_FACTOR" }
    | {
          ok: false;
          reason: "NOT_FOUND" | "FORBIDDEN" | "EXPIRED";
      };

/* ==========================================
 * TOKEN ISSUANCE
 * ========================================== */

/**
 * Mint a fresh guest access token and attach it to an outgoing
 * response as an httpOnly cookie.
 *
 * Returns the RAW token so the caller may also surface a one-time
 * token link (used on the order confirmation page). The raw token is
 * never persisted and never logged.
 */
export function issueGuestOrderAccessCookie(
    response: NextResponse,
    orderId: number,
    rawToken?: string
): string {
    const token = rawToken ?? generateGuestAccessToken();

    response.cookies.set(
        guestOrderCookieName(orderId),
        buildGuestOrderCookieValue(orderId, token),
        {
            httpOnly: true,
            secure:
                process.env.NODE_ENV ===
                "production",
            sameSite: "lax",
            path: "/",
            maxAge: GUEST_ORDER_COOKIE_MAX_AGE_S,
        }
    );

    return token;
}

/**
 * Persist a NEW guest access token for an order: hash + the 30-day
 * server-side expiry, in one write.
 *
 * Every path that persists a token MUST go through here, otherwise the
 * row would carry a hash with no expiry window and be refused
 * (fail-closed) by resolveOrderAccess.
 *
 * Returns the expiry that was written.
 */
export async function persistGuestAccessToken(
    orderId: number,
    rawToken: string
): Promise<Date> {
    const expiresAt = guestAccessTokenExpiry();

    await prisma.order.update({
        where: { id: orderId },
        data: {
            guestAccessTokenHash:
                hashGuestAccessToken(rawToken),
            guestAccessTokenExpiresAt: expiresAt,
        },
    });

    return expiresAt;
}

/**
 * Read the raw guest access token for one order from the cookie jar.
 */
export async function readGuestOrderTokenFromCookies(
    orderId: number
): Promise<string | null> {
    /*
     * FAIL CLOSED when the cookie store is unavailable (outside a
     * request scope, or a runtime without next/headers): treat it as
     * "no token presented" so the caller denies access instead of
     * surfacing a 500. Never throw into an authorization path.
     */
    let rawValue: string | undefined;

    try {
        const cookieStore = await cookies();

        rawValue = cookieStore.get(
            guestOrderCookieName(orderId)
        )?.value;
    } catch {
        return null;
    }

    const parsed = parseGuestOrderCookieValue(
        rawValue
    );

    if (!parsed || parsed.orderId !== orderId) {
        return null;
    }

    return parsed.token;
}

/**
 * List every order this browser holds a VALID guest token for.
 *
 * Each guest order stores its token in its own `gos_<orderId>` cookie,
 * so the cookie jar itself is the index. Every candidate is verified
 * against the stored hash before its order id is returned — a tampered
 * or stale cookie is simply ignored.
 */
export async function listGuestAccessibleOrderIds(): Promise<
    number[]
> {
    /*
     * Same fail-closed rule as readGuestOrderTokenFromCookies: an
     * unavailable cookie store means "this browser holds nothing",
     * which is a safe (empty) answer rather than a 500.
     */
    let all: { name: string; value: string }[];

    try {
        const cookieStore = await cookies();

        all = cookieStore.getAll();
    } catch {
        return [];
    }

    const candidates = all
        .filter((cookie) =>
            cookie.name.startsWith(
                GUEST_ORDER_COOKIE_PREFIX
            )
        )
        .map((cookie) =>
            parseGuestOrderCookieValue(cookie.value)
        )
        .filter(
            (
                parsed
            ): parsed is {
                orderId: number;
                token: string;
            } => parsed !== null
        );

    if (candidates.length === 0) {
        return [];
    }

    const orders = await prisma.order.findMany({
        where: {
            id: {
                in: candidates.map((c) => c.orderId),
            },
        },
        select: {
            id: true,
            guestAccessTokenHash: true,
            guestAccessTokenExpiresAt: true,
        },
    });

    const hashById = new Map(
        orders.map((order) => [
            order.id,
            order.guestAccessTokenHash,
        ])
    );

    const expiryById = new Map(
        orders.map((order) => [
            order.id,
            order.guestAccessTokenExpiresAt,
        ])
    );

    return candidates
        .filter(
            (candidate) =>
                tokenMatchesHash(
                    candidate.token,
                    hashById.get(candidate.orderId) ??
                        null
                ) &&
                /*
                 * A hash match is not enough: the token must also be
                 * inside its server-side window, otherwise the list
                 * would resurrect an expired order.
                 */
                isGuestTokenValid(
                    expiryById.get(candidate.orderId) ??
                        null
                )
        )
        .map((candidate) => candidate.orderId);
}

/**
 * Verify a raw token against a stored hash (constant time not needed
 * for SHA-256 of high-entropy input, but we avoid early-exit compare
 * in a helper for clarity).
 */
export function tokenMatchesHash(
    rawToken: string,
    storedHash: string | null
): boolean {
    if (!storedHash) {
        return false;
    }

    const candidate = hashGuestAccessToken(rawToken);

    return candidate === storedHash;
}

/* ==========================================
 * ACCESS RESOLUTION
 * ========================================== */

/**
 * Resolve access to an order for a GUEST-facing endpoint.
 *
 * @param orderId      Order primary key from the request.
 * @param sessionUserId Authenticated user id, when present.
 * @param rawToken     Raw guest token from cookie, when present.
 */
export async function resolveOrderAccess(input: {
    orderId: number;
    sessionUserId?: string | null;
    rawToken?: string | null;
}): Promise<AccessDecision> {
    const order = await prisma.order.findUnique({
        where: { id: input.orderId },
        select: {
            id: true,
            userId: true,
            guestAccessTokenHash: true,
            guestAccessTokenExpiresAt: true,
        },
    });

    /*
     * Uniform NOT_FOUND for both "no such order" and "not yours":
     * returning FORBIDDEN for a real id would confirm existence and
     * turn this into an order-enumeration oracle.
     */
    if (!order) {
        return { ok: false, reason: "NOT_FOUND" };
    }

    if (
        input.sessionUserId &&
        order.userId === input.sessionUserId
    ) {
        return { ok: true, via: "SESSION" };
    }

    const rawToken =
        input.rawToken ??
        (await readGuestOrderTokenFromCookies(
            input.orderId
        ));

    if (
        rawToken &&
        tokenMatchesHash(
            rawToken,
            order.guestAccessTokenHash
        )
    ) {
        /*
         * The token is genuine — it matches the stored hash — so
         * returning EXPIRED (instead of the uniform NOT_FOUND) leaks
         * nothing: it is only ever reported to a caller who already
         * presented the real secret, and it is what lets the buyer be
         * told to run the OTP recovery flow instead of being left with
         * a misleading "order not found".
         */
        if (
            !isGuestTokenValid(
                order.guestAccessTokenExpiresAt
            )
        ) {
            return { ok: false, reason: "EXPIRED" };
        }

        return { ok: true, via: "TOKEN" };
    }

    return { ok: false, reason: "NOT_FOUND" };
}

/**
 * Guard variant that fetches the full order only when access is
 * granted, so callers cannot accidentally serialize an order before
 * the ownership check.
 */
export async function findOrderWithAccess<T extends object>(
    input: {
        orderId: number;
        sessionUserId?: string | null;
        rawToken?: string | null;
    },        select: T
    ): Promise<
    | { ok: true; order: T; via: string }
    | {
          ok: false;
          reason: "NOT_FOUND" | "FORBIDDEN" | "EXPIRED";
      }
> {
    const decision = await resolveOrderAccess(input);

    if (!decision.ok) {
        return { ok: false, reason: decision.reason };
    }

    const order = (await prisma.order.findUnique({
        where: { id: input.orderId },
        select,
    })) as T | null;

    if (!order) {
        return { ok: false, reason: "NOT_FOUND" };
    }

    return { ok: true, order, via: decision.via };
}

/* ==========================================
 * ROUTE-LEVEL AUTHORIZER
 * ========================================== */

export type OrderRequestAccess =
    | {
          ok: true;
          /** order owner when the requester is logged in, else null */
          userId: string | null;
          via: "SESSION" | "TOKEN";
      }
    | {
          ok: false;
          status: 401 | 404 | 429;
          message: string;
      };

/**
 * Message shown to a buyer whose token is genuine but past its 30-day
 * window. It names the recovery path so the buyer is not stuck. It is
 * only ever returned to a caller that presented the real token, so it
 * cannot be used to probe for existing orders.
 */
const EXPIRED_ACCESS_MESSAGE =
    "Akses pesanan Anda sudah kedaluwarsa. Pulihkan akses dengan kode verifikasi WhatsApp.";

/**
 * Authorize a request for ONE order id, for every guest-facing order
 * endpoint (detail, tracking, cancel, expire, payment status, repay,
 * refund).
 *
 * Grants access only for:
 *   - the authenticated owner of the order, or
 *   - a caller presenting a valid guest access token for that order.
 *
 * Everything else returns 404 (never 403) so a sequential order id
 * cannot be used as an existence oracle.
 *
 * Guest calls are additionally rate limited per IP, on TWO buckets:
 * the strict enumeration budget for anything that did NOT authorize, and
 * a much larger ceiling for a caller who presented this order's own
 * token (see the comment inside). On success the route receives
 * `userId` — the SESSION id when present, or null for a token-authorized
 * guest, which is what the downstream helpers use to skip user-scoped
 * filtering. Ownership has ALREADY been proven here, so a null userId is
 * never "unowned".
 */
export async function authorizeOrderRequest(
    request: Request,
    orderId: number
): Promise<OrderRequestAccess> {
    const session = await auth();

    const sessionUserId =
        session?.user?.id ?? null;

    const decision = await resolveOrderAccess({
        orderId,
        sessionUserId,
    });

    /*
     * ==========================================
     * GUEST RATE LIMITING — TWO BUCKETS
     * ==========================================
     *
     * The ENUMERATION surface is a request that does NOT authorize: no
     * cookie, a forged or other-order token, an id that does not exist.
     * Those keep the strict `guestOrderLookup` budget (10 / 15 min / IP),
     * so guessing ids or grinding tokens stays capped.
     *
     * A request that DID authorize is not enumeration at all — the token
     * is 256 bits, bound to this one order, and the read is a single
     * indexed lookup — so it is charged to a much larger ceiling
     * instead. Charging authorized reads to the strict budget locked
     * legitimate buyers out of their own order: the customer payment
     * page polls `/payment-status` every 3 seconds, which exhausts
     * 10 requests in about 30 seconds. The same budget is shared by the
     * order detail, tracking and payment-status routes, so a buyer who
     * simply refreshes their order a few times could be denied too.
     *
     * This is evaluated AFTER resolution on purpose: the resolution is
     * what tells a buyer apart from an attacker, and an unauthorized
     * caller is still capped at the strict budget, so the amount of work
     * a guesser can force stays bounded.
     *
     * An EXPIRED token also counts as a genuine buyer: the hash matched,
     * so the caller really holds this order's secret and is being sent to
     * the OTP recovery flow rather than being treated as enumeration.
     */
    if (!sessionUserId) {
        const ip = getClientIp(request);

        const bucketKey = guestIpKey({
            ip,
            scope: "order-access",
        });

        const genuineBuyer =
            decision.ok ||
            decision.reason === "EXPIRED";

        const limit = genuineBuyer
            ? rateLimiters.guestOrderAccessAuthorized(
                  bucketKey
              )
            : rateLimiters.guestOrderLookup(bucketKey);

        if (!limit.allowed) {
            return {
                ok: false,
                status: 429,
                message:
                    "Terlalu banyak permintaan. Coba lagi nanti.",
            };
        }
    }

    if (!decision.ok) {
        if (decision.reason === "EXPIRED") {
            return {
                ok: false,
                status: 401,
                message: EXPIRED_ACCESS_MESSAGE,
            };
        }

        return {
            ok: false,
            status: 404,
            message: "Pesanan tidak ditemukan.",
        };
    }

    return {
        ok: true,
        userId: sessionUserId,
        via: decision.via as "SESSION" | "TOKEN",
    };
}

/* ==========================================
 * SECOND-FACTOR LOOKUP (lost cookie / other device)
 * ========================================== */

/**
 * Find a guest order by orderNumber + a matching second factor
 * (the email OR the phone given at checkout).
 *
 * The caller MUST rate limit this endpoint aggressively — it is the
 * only path where knowledge of the order number is not by itself
 * sufficient but knowledge of a contact detail plus a guessable order
 * number is.
 */
export async function findOrderBySecondFactor(input: {
    orderNumber: string;
    email?: unknown;
    phone?: unknown;
}) {
    const order = await prisma.order.findUnique({
        where: { orderNumber: input.orderNumber },
        select: {
            id: true,
            userId: true,
            orderNumber: true,
            customerEmail: true,
            phone: true,
            guestAccessTokenHash: true,
        },
    });

    if (!order) {
        return null;
    }

    const normalizedEmail = normalizeEmail(
        input.email
    );

    const normalizedPhone = normalizePhone(
        input.phone
    );

    if (!normalizedEmail && !normalizedPhone) {
        return null;
    }

    const emailMatches = Boolean(
        normalizedEmail &&
            order.customerEmail &&
            normalizeEmail(order.customerEmail) ===
                normalizedEmail
    );

    const phoneMatches = Boolean(
        normalizedPhone &&
            normalizePhone(order.phone) ===
                normalizedPhone
    );

    if (!emailMatches && !phoneMatches) {
        return null;
    }

    return order;
}
