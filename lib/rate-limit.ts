/**
 * ==========================================
 * RATE LIMITER (In-Memory)
 * ==========================================
 *
 * Simple sliding-window rate limiter using
 * in-memory Map.
 *
 * PRODUCTION NOTE:
 * For multi-instance deployments (Kubernetes,
 * serverless, clustered), this in-memory
 * implementation is per-instance. Each instance
 * maintains its own counters.
 *
 * To use distributed rate limiting, set
 * REDIS_URL environment variable and install
 * @upstash/ratelimit or ioredis.
 *
 * When REDIS_URL is set, this module logs a
 * warning to remind about single-instance
 * limitation.
 */

const isProduction = process.env.NODE_ENV === "production";
const hasRedisUrl = Boolean(process.env.REDIS_URL);

if (isProduction && hasRedisUrl) {
    console.warn(
        "[RATE_LIMIT] REDIS_URL is set but Redis rate limiting " +
        "is not configured. Using in-memory rate limiter which " +
        "is per-instance. Install @upstash/ratelimit for " +
        "distributed rate limiting."
    );
}

type RateLimitEntry = {
    count: number;
    resetAt: number;
};

const store = new Map<string, RateLimitEntry>();

/*
 * Cleanup expired entries every 5 minutes.
 *
 * `unref()` matters here: without it this module-level timer keeps the
 * Node event loop alive, so any process that merely IMPORTS the limiter
 * (a Jest run, a CLI script) never exits on its own — Jest reports the
 * leaked handle and has to force-exit the worker. In the Next.js server
 * the HTTP server keeps the loop alive anyway, so unref() changes no
 * runtime behaviour.
 */
if (typeof setInterval !== "undefined") {
    const cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of store) {
            if (now > entry.resetAt) {
                store.delete(key);
            }
        }
    }, 5 * 60 * 1000);

    cleanupTimer.unref?.();
}

export type RateLimitResult = {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
};

/**
 * Check rate limit for a given key.
 *
 * @param key - Unique identifier (e.g., "login:192.168.1.1")
 * @param maxRequests - Maximum requests allowed in window
 * @param windowMs - Time window in milliseconds
 * @returns Rate limit result
 */
export function checkRateLimit(
    key: string,
    maxRequests: number = 10,
    windowMs: number = 60 * 1000
): RateLimitResult {
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now > entry.resetAt) {
        // New window
        store.set(key, {
            count: 1,
            resetAt: now + windowMs,
        });
        return {
            allowed: true,
            remaining: maxRequests - 1,
            retryAfterMs: 0,
        };
    }

    if (entry.count >= maxRequests) {
        return {
            allowed: false,
            remaining: 0,
            retryAfterMs: entry.resetAt - now,
        };
    }

    entry.count++;
    return {
        allowed: true,
        remaining: maxRequests - entry.count,
        retryAfterMs: 0,
    };
}

/**
 * Get client IP from request headers.
 *
 * Security (M2 fix):
 * x-forwarded-for and x-real-ip are client-controllable
 * headers. They MUST NOT be trusted unless the application
 * is behind a known trusted reverse proxy.
 *
 * When TRUSTED_PROXY env var is NOT set (default):
 *   Forwarding headers are ignored.
 *   Returns "untrusted" — all clients share this bucket.
 *   This is safe: rate limiting still works, it just groups
 *   all untrusted clients together.
 *
 * When TRUSTED_PROXY env var IS set:
 *   Forwarding headers from the trusted proxy are used.
 *   The first IP in x-forwarded-for is treated as client IP.
 *
 * This prevents an attacker from spoofing x-forwarded-for
 * to obtain a unique rate-limit bucket per request.
 */
export const UNTRUSTED_IP = "untrusted";

/**
 * How many trusted proxies sit in front of the app.
 *
 * `TRUSTED_PROXY` enables header trust; `TRUSTED_PROXY_HOPS` says how
 * many hops from the right are OUR OWN proxies (default 1: a single
 * nginx/Apache in front of the app). A deployment behind a CDN that
 * also forwards to that proxy sets it to 2.
 */
function trustedProxyHops(): number {
    const raw = Number(process.env.TRUSTED_PROXY_HOPS ?? "1");

    if (!Number.isInteger(raw) || raw < 1) {
        return 1;
    }

    // A chain we cannot reason about is not one we should trust deeply.
    return Math.min(raw, 10);
}

/**
 * Is this value an IP literal we are willing to use as a bucket key?
 *
 * The value ends up in a rate-limit key, so a hostname, a port suffix
 * or an arbitrary string must never be accepted: an attacker-crafted
 * key that collides with another bucket would let a client consume (or
 * dodge) someone else's budget.
 */
function isIpLiteral(value: string): boolean {
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(
        value
    );

    if (ipv4) {
        return ipv4.slice(1).every((octet) => Number(octet) <= 255);
    }

    // IPv6 (any textual form). Reject anything with a port/brackets.
    return /^[0-9a-fA-F:]{2,45}$/.test(value) && value.includes(":");
}

/**
 * Get client IP from request headers.
 *
 * Security (M2 fix, extended):
 * x-forwarded-for and x-real-ip are client-controllable
 * headers. They MUST NOT be trusted unless the application
 * is behind a known trusted reverse proxy.
 *
 * When TRUSTED_PROXY env var is NOT set (default):
 *   Forwarding headers are ignored.
 *   Returns "untrusted" — all clients share this bucket.
 *   This is safe: rate limiting still works, it just groups
 *   all untrusted clients together.
 *
 * When TRUSTED_PROXY env var IS set:
 *   The client IP is the entry `TRUSTED_PROXY_HOPS` from the RIGHT of
 *   x-forwarded-for (default: the rightmost).
 *
 *   WHY THE RIGHT, AND NOT THE LEFT
 *   -------------------------------
 *   `x-forwarded-for` is an APPEND-ONLY list: every proxy adds the
 *   address it saw. A client can send its own header, so the LEFTMOST
 *   value may be pure fabrication — and proxies configured with
 *   `proxy_add_x_forwarded_for` append the real client address to it.
 *   The entries on the RIGHT were written by our own proxies, which is
 *   the only part of the chain we control, so the client address is
 *   counted from there.
 *
 *   Concretely, for `client → nginx → app`:
 *     - a normal request              → "203.0.113.9"
 *     - a spoofed `X-Forwarded-For:
 *       1.2.3.4`                      → nginx appends the real client,
 *                                        and the fake value is ignored
 *   For `client → CDN → nginx → app`, set TRUSTED_PROXY_HOPS=2.
 *
 *   A value that is not an IP literal (or a request with no usable
 *   header) fails closed to "untrusted" instead of minting a bucket key
 *   out of an attacker-supplied string.
 *
 * See docs/TRUSTED-PROXY.md for the production configuration and the
 * verification procedure.
 */
export function getClientIp(request: Request): string {
    const trustedProxy = process.env.TRUSTED_PROXY;

    if (trustedProxy) {
        const forwarded = request.headers.get("x-forwarded-for");

        if (forwarded) {
            const chain = forwarded
                .split(",")
                .map((part) => part.trim())
                .filter((part) => part.length > 0);

            const candidate =
                chain[chain.length - trustedProxyHops()];

            if (candidate && isIpLiteral(candidate)) {
                return candidate;
            }
        }

        /*
         * x-real-ip is only meaningful when the proxy OVERWRITES it
         * (`proxy_set_header X-Real-IP $remote_addr`). It is used as a
         * fallback, and still has to be a real IP literal.
         */
        const realIp = request.headers.get("x-real-ip")?.trim();

        if (realIp && isIpLiteral(realIp)) {
            return realIp;
        }
    }

    // No trusted proxy — forwarding headers are NOT trustworthy
    return UNTRUSTED_IP;
}

/**
 * ==========================================
 * GUEST RATE-LIMIT KEYS
 * ==========================================
 *
 * Guest (unauthenticated) traffic has no userId, so every guest-facing
 * limiter must be keyed on something else.
 *
 * TWO-WAY PROTECTION
 * ------------------
 * `getClientIp()` returns the literal "untrusted" when TRUSTED_PROXY is
 * not configured. Using that alone as the ONLY key would put the entire
 * internet in a single bucket: one abusive client could then either
 * (a) exhaust the bucket and deny service to every other guest, or
 * (b) be masked by legitimate traffic. Neither is acceptable, so guest
 * limiters are evaluated against BOTH:
 *
 *   - a DEVICE/IP key (coarse: stops one client hammering us), and
 *   - an IDENTITY key (normalized+hashed email/phone: stops one person
 *     rotating IPs to farm caps).
 *
 * Callers must treat a denial from EITHER bucket as a denial.
 *
 * DEPLOYMENT NOTE: set TRUSTED_PROXY in production (behind the reverse
 * proxy) so the device key becomes a real per-client key instead of the
 * shared "untrusted" bucket. See the final report for details.
 */
export type GuestLimitInput = {
    /** trusted-proxy aware client IP, or "untrusted" */
    ip: string;
    /** scope discriminator, e.g. "checkout" */
    scope: string;
    /** normalized+hashed guest identity, when known */
    identityKey?: string | null;
    /** extra device-ish discriminator (cart token hash), when known */
    deviceKey?: string | null;
};

/** IP/device bucket key. */
export function guestIpKey(input: GuestLimitInput): string {
    return `guest:${input.scope}:ip:${input.ip}`;
}

/** Cart/device bucket key, used when no identity is known yet. */
export function guestDeviceKey(input: GuestLimitInput): string | null {
    if (!input.deviceKey) {
        return null;
    }

    return `guest:${input.scope}:dev:${input.deviceKey}`;
}

/** Identity bucket key (hashed email/phone); null when unknown. */
export function guestIdentityKey(input: GuestLimitInput): string | null {
    if (!input.identityKey) {
        return null;
    }

    return `guest:${input.scope}:id:${input.identityKey}`;
}

/**
 * Pre-configured rate limiters for sensitive endpoints.
 */
export const rateLimiters = {
    login: (ip: string) =>
        checkRateLimit(`login:${ip}`, 5, 15 * 60 * 1000), // 5 attempts per 15 min

    voucherValidation: (ip: string) =>
        checkRateLimit(`voucher:${ip}`, 20, 60 * 1000), // 20 per minute

    orderCreation: (userId: string) =>
        checkRateLimit(`order:${userId}`, 10, 60 * 1000), // 10 per minute

    register: (ip: string) =>
        checkRateLimit(`register:${ip}`, 3, 60 * 60 * 1000), // 3 per hour

    broadcastSend: (userId: string) =>
        checkRateLimit(`broadcast:${userId}`, 5, 60 * 1000), // 5 per minute

    broadcastCreate: (userId: string) =>
        checkRateLimit(`broadcast-create:${userId}`, 10, 60 * 1000), // 10 per minute

    // Payment creation — prevent rapid-fire payment attempts
    paymentCreation: (userId: string) =>
        checkRateLimit(`payment:${userId}`, 5, 5 * 60 * 1000), // 5 per 5 min

    // Spin wheel — prevent rapid spin attempts
    spin: (userId: string) =>
        checkRateLimit(`spin:${userId}`, 10, 60 * 1000), // 10 per minute

    // Affiliate payout — prevent rapid withdrawal requests
    affiliatePayout: (userId: string) =>
        checkRateLimit(`payout:${userId}`, 3, 60 * 60 * 1000), // 3 per hour

    // File upload — prevent upload flooding
    upload: (userId: string) =>
        checkRateLimit(`upload:${userId}`, 20, 60 * 1000), // 20 per minute

    // Refund request — prevent rapid refund attempts
    refundRequest: (userId: string) =>
        checkRateLimit(`refund:${userId}`, 3, 60 * 60 * 1000), // 3 per hour

    // Repayment — prevent rapid repayment attempts
    repayment: (userId: string) =>
        checkRateLimit(`repay:${userId}`, 5, 5 * 60 * 1000), // 5 per 5 min

    // Shipping cost — public endpoint backed by paid RajaOngkir calls
    shippingCost: (ip: string) =>
        checkRateLimit(`shipping:${ip}`, 60, 60 * 1000), // 60 per minute

    /*
     * ==========================================
     * GUEST (UNAUTHENTICATED CUSTOMER) LIMITERS
     * ==========================================
     *
     * These accept a pre-built key from guestIpKey()/guestDeviceKey()/
     * guestIdentityKey() so each caller can apply the combination that
     * fits its endpoint.
     */

    // Cart mutations: generous, but stops scripted flooding.
    guestCart: (key: string) =>
        checkRateLimit(`gcart:${key}`, 120, 60 * 1000), // 120 per minute

    // Guest checkout: per-device and per-identity.
    guestCheckoutDevice: (key: string) =>
        checkRateLimit(`gco:${key}`, 10, 60 * 1000), // 10 per minute

    guestCheckoutIdentity: (key: string) =>
        checkRateLimit(`gco-id:${key}`, 20, 60 * 60 * 1000), // 20 per hour

    // Guest COD: the highest-abuse surface (no prepayment).
    guestCodDevice: (key: string) =>
        checkRateLimit(`gcod:${key}`, 5, 60 * 60 * 1000), // 5 per hour

    guestCodIdentity: (key: string) =>
        checkRateLimit(`gcod-id:${key}`, 3, 24 * 60 * 60 * 1000), // 3 per day

    // Guest spin wheel (no userId to key on).
    guestSpin: (key: string) =>
        checkRateLimit(`gspin:${key}`, 15, 60 * 1000), // 15 per minute

    // Guest order lookup by second factor (orderNumber + email/phone).
    guestOrderLookup: (key: string) =>
        checkRateLimit(`glookup:${key}`, 10, 15 * 60 * 1000), // 10 per 15 min

    /*
     * Guest order access that AUTHORIZED with this order's own token.
     *
     * Kept separate from guestOrderLookup because the two measure
     * opposite things: `guestOrderLookup` bounds the ENUMERATION surface
     * (no token / forged token / unknown id), while this bucket only
     * bounds sustained volume from a caller who already holds a 256-bit
     * token bound to one order — i.e. the buyer themselves.
     *
     * The customer payment page polls its status every 3 seconds while
     * payment is pending (~300 requests per 15 min for a page left
     * open), and a buyer may refresh the order detail repeatedly. Both
     * must stay well inside this ceiling, so it is set at 600 per
     * 15 min (~40/min) — 2x the polling rate, while still capping a
     * client that hammers the endpoint.
     */
    guestOrderAccessAuthorized: (key: string) =>
        checkRateLimit(`gaccess:${key}`, 600, 15 * 60 * 1000), // 600 per 15 min

    guestOrderLookupIdentity: (key: string) =>
        checkRateLimit(`glookup-id:${key}`, 20, 60 * 60 * 1000), // 20 per hour

    // Guest order RECOVERY (two-phase OTP).
    //
    // Phase 1 (request) is deliberately tighter than phase 2: every
    // request costs a real WhatsApp message, so it is the expensive and
    // abusable step. Phase 2 (confirm) also has a per-challenge attempt
    // budget (see lib/guest-recovery.ts) — this bucket only stops a
    // client from grinding many DIFFERENT challenge ids.
    guestRecoveryRequest: (key: string) =>
        checkRateLimit(`grec:${key}`, 5, 15 * 60 * 1000), // 5 per 15 min

    guestRecoveryConfirm: (key: string) =>
        checkRateLimit(`grecv:${key}`, 20, 15 * 60 * 1000), // 20 per 15 min

    // Shipping estimate / cost from a guest browser (paid provider calls).
    guestShippingQuote: (key: string) =>
        checkRateLimit(`gshipping:${key}`, 60, 60 * 1000), // 60 per minute

    /*
     * PUBLIC RESI TRACKING (no account, resi only).
     *
     * Two buckets, because a resi lookup is BOTH a per-client volume
     * surface and an ENUMERATION surface: `publicResiLookup` bounds one
     * client hammering the route, while `publicResiLookupIdentity`
     * bounds how often ONE resi may be probed (an attacker guessing
     * waybills cannot grind a single hit, and a real customer checking
     * their own parcel stays far inside the ceiling).
     */
    publicResiLookup: (key: string) =>
        checkRateLimit(`resi:${key}`, 20, 60 * 1000), // 20 per minute

    publicResiLookupIdentity: (key: string) =>
        checkRateLimit(`resi-id:${key}`, 30, 60 * 60 * 1000), // 30 per hour
};
