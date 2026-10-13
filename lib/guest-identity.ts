import crypto from "crypto";

/**
 * ==========================================
 * GUEST IDENTITY (server-side only)
 * ==========================================
 *
 * The storefront is guest-only for customers: there is no customer
 * account, so per-identity abuse controls (voucher `maxUsagePerUser`,
 * flash-sale purchase limits, COD caps and affiliate self-referral)
 * need a stable scope that does NOT depend on `session.user.id`.
 *
 * This module derives that scope from the buyer contact details that
 * a guest already has to supply at checkout (email + phone).
 *
 * DESIGN RULES
 * ------------
 * 1. Raw contact data is NEVER stored in these derived columns.
 * 2. Hashes are keyed (HMAC-SHA256) with a server secret. A plain
 *    unsalted SHA-256 of a phone number is trivially brute-forced —
 *    Indonesian mobile numbers have very low entropy — so the keyed
 *    form is required for it to be worth anything.
 * 3. An identity key is an ABUSE-CONTROL SCOPE, never an
 *    authentication credential. Hashing a contact value is not proof
 *    that the person controls it; anything that needs a real
 *    ownership guarantee must use a verified channel instead.
 * 4. Nothing here is ever serialized into a response body, cookie,
 *    log line or analytics payload.
 */

/**
 * Secret used to key the identity hashes.
 *
 * AUTH_SECRET is already a required, stable deployment secret for
 * NextAuth (admin/affiliate login), so reusing it means no new
 * production configuration is needed. GUEST_IDENTITY_PEPPER is
 * honoured as an explicit override for rotation/redeployment.
 *
 * IMPORTANT (deployment): changing this value invalidates every
 * stored guestIdentityKey / ownerKey. Existing rows keep working
 * (they simply stop matching new checkouts), so a rotation is safe
 * but lets previously-capped guests get a fresh allowance.
 */
function identitySecret(): string {
    const secret =
        process.env.GUEST_IDENTITY_PEPPER ||
        process.env.AUTH_SECRET;

    if (!secret) {
        /*
         * Fail closed: without a keyed hash the derived scope would
         * be brute-forceable, which is worse than having no cap at
         * all because it looks like protection while providing none.
         */
        throw new Error(
            "Guest identity hashing is not configured (AUTH_SECRET / GUEST_IDENTITY_PEPPER missing)."
        );
    }

    return secret;
}

/**
 * Keyed hash of a single normalized contact value.
 * Returns a 64-char lowercase hex digest.
 */
export function hashContact(value: string): string {
    return crypto
        .createHmac("sha256", identitySecret())
        .update(value)
        .digest("hex");
}

/**
 * Normalize an email for comparison.
 * Returns null when the value is missing or obviously unusable.
 */
export function normalizeEmail(
    raw: unknown
): string | null {
    if (typeof raw !== "string") {
        return null;
    }

    const value = raw.trim().toLowerCase();

    if (!value || !value.includes("@")) {
        return null;
    }

    return value;
}

/**
 * Normalize an Indonesian phone number to the `62...` form so that
 * `0812...`, `+62 812...`, `62812...` and `812...` all collapse to
 * the same identity.
 *
 * Non-Indonesian numbers keep their digits (with a leading `+`
 * stripped) so foreign buyers are still scoped consistently.
 */
export function normalizePhone(
    raw: unknown
): string | null {
    if (
        typeof raw !== "string" &&
        typeof raw !== "number"
    ) {
        return null;
    }

    const digits = String(raw).replace(/\D/g, "");

    if (!digits) {
        return null;
    }

    if (digits.startsWith("62")) {
        return digits;
    }

    if (digits.startsWith("0")) {
        return `62${digits.replace(/^0+/, "")}`;
    }

    if (digits.startsWith("8")) {
        return `62${digits}`;
    }

    return digits;
}

/**
 * Per-contact fingerprints, used to detect a buyer acting as (or
 * through) an affiliate. One entry per available contact value so an
 * affiliate matches on EITHER a shared email OR a shared phone.
 *
 * Format: "e:<hash>" | "p:<hash>"
 */
export function contactFingerprints(input: {
    email?: unknown;
    phone?: unknown;
}): string[] {
    const fingerprints: string[] = [];

    const email = normalizeEmail(input.email);

    if (email) {
        fingerprints.push(`e:${hashContact(email)}`);
    }

    const phone = normalizePhone(input.phone);

    if (phone) {
        fingerprints.push(`p:${hashContact(phone)}`);
    }

    return fingerprints;
}

/**
 * Stable scope for a guest order/buyer.
 *
 * Returns null when the guest supplied neither a usable email nor a
 * usable phone — callers then fall back to IP-based limiting only
 * rather than silently sharing one global bucket.
 *
 * Format: "g1:<emailHash|->:<phoneHash|->"
 * The version prefix (`g1`) allows a future rotation to be
 * distinguished from today's keys.
 */
export function buildGuestIdentityKey(input: {
    email?: unknown;
    phone?: unknown;
}): string | null {
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);

    if (!email && !phone) {
        return null;
    }

    const emailPart = email
        ? hashContact(email)
        : "-";

    const phonePart = phone
        ? hashContact(phone)
        : "-";

    return `g1:${emailPart}:${phonePart}`;
}

/**
 * The `ownerKey` stored on FlashSalePurchase / VoucherUserUsage /
 * SpinWheelSpin. It is the authoritative per-identity scope for the
 * purchase/usage limits.
 *
 * A logged-in actor always wins over a guest key so an affiliate or
 * admin checking out while signed in keeps the historical behaviour.
 */
export function ownerKeyForUser(userId: string): string {
    return `user:${userId}`;
}

export function ownerKeyForGuest(
    guestIdentityKey: string
): string {
    return `guest:${guestIdentityKey}`;
}

/**
 * Resolve the owning scope for a checkout / spin.
 */
export function resolveOwnerKey(input: {
    userId?: string | null;
    guestIdentityKey?: string | null;
}): string {
    if (input.userId) {
        return ownerKeyForUser(input.userId);
    }

    if (input.guestIdentityKey) {
        return ownerKeyForGuest(
            input.guestIdentityKey
        );
    }

    /*
     * Should be unreachable: checkout always has either a session or
     * a guest identity. Fail loudly rather than collapsing every
     * anonymous caller into one shared bucket.
     */
    throw new Error(
        "Tidak dapat menentukan identitas pembeli."
    );
}

/**
 * Resolve a limit scope from an explicit `ownerKey` (preferred) or a
 * legacy `userId`, returning null when neither is available.
 *
 * This keeps the pre-existing `userId`-based call signatures working
 * (logged-in paths and their regression tests) while letting the guest
 * checkout path pass its hashed identity scope explicitly.
 */
export function resolveUsageScope(input: {
    ownerKey?: string | null;
    userId?: string | null;
}): string | null {
    if (input.ownerKey) {
        return input.ownerKey;
    }

    if (input.userId) {
        return ownerKeyForUser(input.userId);
    }

    return null;
}

/**
 * Resolve the limit scope that an ORDER belongs to.
 *
 * Used when releasing/re-reserving a voucher or flash-sale purchase for
 * an existing order (rollback, cancel, repay, refund): the order must
 * be scoped exactly as it was when created, whether it was placed by a
 * logged-in customer or a guest.
 */
export function orderOwnerKey(order: {
    userId?: string | null;
    guestIdentityKey?: string | null;
}): string | null {
    return resolveUsageScope({
        userId: order.userId ?? null,
        ownerKey: order.guestIdentityKey
            ? ownerKeyForGuest(order.guestIdentityKey)
            : null,
    });
}

/**
 * Same as resolveUsageScope, but FAIL-CLOSED: a caller that is about to
 * consume a limited resource must always have a scope, otherwise the
 * limit would be silently skipped for that purchase.
 */
export function requireUsageScope(input: {
    ownerKey?: string | null;
    userId?: string | null;
}): string {
    const scope = resolveUsageScope(input);

    if (!scope) {
        throw new Error(
            "Tidak dapat menentukan batas pemakaian: identitas pembeli tidak tersedia."
        );
    }

    return scope;
}

/* ==========================================
 * GUEST ORDER ACCESS TOKEN
 * ========================================== */

/** 32 bytes of CSPRNG entropy, base64url encoded (43 chars). */
export function generateGuestAccessToken(): string {
    return crypto
        .randomBytes(32)
        .toString("base64url");
}

/**
 * Hash a guest access token for storage.
 *
 * The token itself is already 256 bits of CSPRNG output, so a plain
 * SHA-256 (no pepper) is sufficient here and — unlike the identity
 * hash — stays stable, which keeps DB lookups cheap. The RAW token
 * is only ever sent to the buyer's browser via an httpOnly cookie.
 */
export function hashGuestAccessToken(
    token: string
): string {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

/**
 * Constant-time comparison for token/secret equality.
 */
export function safeEqual(
    a: string,
    b: string
): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);

    if (bufA.length !== bufB.length) {
        return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
}

/* ==========================================
 * GUEST ORDER ACCESS COOKIE
 * ========================================== */

/**
 * One cookie per order: an order-opaque cookie name avoids leaking
 * the order id/enumeration surface into the cookie jar and lets a
 * single browser legitimately hold several guest orders.
 *
 * The cookie value is `<orderId>.<rawToken>`; the RAW token never
 * appears alone (so it cannot be replayed against another order).
 */
export const GUEST_ORDER_COOKIE_PREFIX =
    "gos_";

/** 30 days — long enough to service a repayment/refund. */
export const GUEST_ORDER_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30;

/**
 * SERVER-SIDE validity window of a guest access token: 30 days.
 *
 * The cookie's `maxAge` above is only a browser hint — the browser may
 * keep (or resurrect) the cookie for longer, and the cookie is
 * attacker-controlled in any case. THIS value is what the server
 * actually enforces against `Order.guestAccessTokenExpiresAt` in
 * resolveOrderAccess().
 *
 * Keep the two in step: a cookie that outlives its server-side window
 * is simply rejected, and an expired buyer recovers access through the
 * OTP flow instead (the order itself is never deleted).
 */
export const GUEST_ACCESS_TOKEN_TTL_MS =
    60 * 60 * 24 * 30 * 1000;

/**
 * Expiry timestamp for a token issued at `from` (default: now).
 */
export function guestAccessTokenExpiry(
    from: Date = new Date()
): Date {
    return new Date(
        from.getTime() + GUEST_ACCESS_TOKEN_TTL_MS
    );
}

/**
 * True when a stored guest token expiry is still in the future.
 *
 * FAIL CLOSED: a NULL expiry on an order that carries a token hash is
 * treated as expired (it means the token predates the expiry column and
 * was never backfilled), so an un-migrated row can never grant
 * indefinite access.
 */
export function isGuestTokenValid(
    expiresAt: Date | null | undefined,
    now: Date = new Date()
): boolean {
    if (!expiresAt) {
        return false;
    }

    return expiresAt.getTime() > now.getTime();
}

/* ==========================================
 * GUEST ORDER RECOVERY (OTP)
 * ========================================== */

/**
 * A 6-digit numeric OTP from the CSPRNG.
 *
 * `Math.random` is never acceptable for a credential, however short
 * lived: it is predictable from a handful of outputs.
 */
export function generateRecoveryCode(): string {
    return String(
        crypto.randomInt(0, 1_000_000)
    ).padStart(6, "0");
}

/**
 * Keyed hash of a recovery OTP, bound to its challenge id.
 *
 * The pepper matters even more here than for the identity hashes: a
 * 6-digit code has only 10^6 possible values, so an unsalted digest of
 * a leaked `codeHash` would be recoverable in milliseconds. Binding the
 * challenge id into the input also means a hash from one challenge can
 * never validate another.
 */
export function hashRecoveryCode(
    challengeId: string,
    code: string
): string {
    return hashContact(
        `recovery-otp:${challengeId}:${code}`
    );
}

export function guestOrderCookieName(
    orderId: number
): string {
    return `${GUEST_ORDER_COOKIE_PREFIX}${orderId}`;
}

export function buildGuestOrderCookieValue(
    orderId: number,
    rawToken: string
): string {
    return `${orderId}.${rawToken}`;
}

/**
 * Parse a `<orderId>.<token>` cookie value into its parts.
 * Returns null for anything malformed.
 */
export function parseGuestOrderCookieValue(
    value: string | undefined | null
): { orderId: number; token: string } | null {
    if (!value) {
        return null;
    }

    const separator = value.indexOf(".");

    if (separator <= 0) {
        return null;
    }

    const orderId = Number(
        value.slice(0, separator)
    );

    const token = value.slice(separator + 1);

    if (
        !Number.isInteger(orderId) ||
        orderId <= 0 ||
        !token
    ) {
        return null;
    }

    return { orderId, token };
}
