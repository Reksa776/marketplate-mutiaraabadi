import "server-only";

import { createHash } from "crypto";

/**
 * ==========================================
 * TIKTOK ADVANCED MATCHING — USER MATCH KEYS
 * ==========================================
 *
 * Single, central place that turns RAW customer identity into the
 * hashed match keys TikTok accepts.
 *
 * Official rules implemented here (TikTok Advanced Matching +
 * Events API 2.0 identity/data normalization):
 *
 *   email
 *     - trim, then lowercase
 *     - NO other preprocessing before hashing
 *     - SHA-256 only
 *
 *   phone
 *     - E.164: "+<country code><number without trunk prefix>"
 *     - the leading "+" IS part of the hashed string
 *     - SHA-256 only
 *
 *   external_id
 *     - trim before hashing
 *     - SHA-256 only
 *
 * SECURITY / PRIVACY CONTRACT (enforced by this module):
 *   - `server-only`: never reachable from the browser bundle
 *   - the raw value is NEVER returned, logged, stored, or hashed
 *     into a cache — it exists only inside the function call
 *   - an empty / invalid / missing value yields `null` so callers
 *     OMIT the key. We never send an empty string, a placeholder,
 *     or the hash of nothing.
 *   - deterministic: the same input always produces the same
 *     digest, so the browser Pixel and the server Events API can
 *     share one canonical value.
 */

/** TikTok only accepts SHA-256 for pre-hashed identifiers. */
export const TIKTOK_MATCH_HASH_ALGORITHM = "sha256";

/**
 * Practical maximum for an email address (RFC 5321 forward path).
 * Anything longer is not an email and is dropped instead of hashed.
 */
export const MAX_TIKTOK_MATCH_EMAIL_LENGTH = 254;

/** E.164 allows at most 15 digits (country code included). */
export const MAX_TIKTOK_MATCH_PHONE_DIGITS = 15;

/** E.164 shortest realistic subscriber number. */
export const MIN_TIKTOK_MATCH_PHONE_DIGITS = 8;

/**
 * Default country calling code.
 *
 * This store is Indonesian only (IDR pricing, Indonesian
 * addresses, RajaOngkir regions), so a local number is always
 * placed in the Indonesian numbering plan. Numbers that cannot be
 * placed confidently are dropped rather than guessed — a wrong
 * country code hashes to a value that matches nobody.
 */
export const DEFAULT_TIKTOK_MATCH_CALLING_CODE = "62";

/** Deliberately permissive: TikTok hashes whatever is a plausible email. */
const EMAIL_SHAPE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Hashed match keys, ready to place in the Events API `user`
 * object or to hand to the browser Pixel. Every field is OPTIONAL:
 * absent means "the app does not legitimately have this value".
 */
export type TikTokUserMatch = {
    /** SHA-256(email), or absent when unknown / invalid. */
    email?: string;
    /** SHA-256(E.164 phone), or absent when unknown / invalid. */
    phone?: string;
    /** SHA-256(stable internal customer id), or absent. */
    external_id?: string;
};

export type TikTokUserMatchInput = {
    /** RAW email. Hashed before it leaves this function. */
    email?: unknown;
    /** RAW phone. Hashed before it leaves this function. */
    phone?: unknown;
    /** RAW stable customer identifier (e.g. the user id). */
    externalId?: unknown;
};

/**
 * Normalize a raw email exactly the way TikTok hashes it:
 * trimmed, lowercased, nothing else.
 *
 * Returns null for anything that is not a plausible email, so the
 * caller omits the key instead of sending junk.
 */
export function normalizeTikTokMatchEmail(
    value: unknown
): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const email = value.trim().toLowerCase();

    if (!email) {
        return null;
    }

    if (
        email.length >
        MAX_TIKTOK_MATCH_EMAIL_LENGTH
    ) {
        return null;
    }

    if (!EMAIL_SHAPE_PATTERN.test(email)) {
        return null;
    }

    return email;
}

/**
 * Normalize a raw phone number to TikTok's E.164 form:
 * `+<country code><number>`, digits only after the plus.
 *
 * Handles the shapes this store actually stores (Indonesian
 * numbers, with or without the international prefix) and keeps
 * already-international numbers intact.
 *
 * Returns null when the number cannot be placed in a country
 * confidently — omitted is always better than a wrong guess.
 */
export function normalizeTikTokMatchPhone(
    value: unknown
): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const raw = value.trim();

    if (!raw) {
        return null;
    }

    /*
     * A "+" anywhere but the very start is not an international
     * number, so only a leading plus is treated as one.
     */
    const hasInternationalPrefix =
        raw.startsWith("+");

    const digits = raw.replace(
        /[^0-9]/g,
        ""
    );

    if (!digits) {
        return null;
    }

    const callingCode =
        DEFAULT_TIKTOK_MATCH_CALLING_CODE;

    let international: string;

    if (hasInternationalPrefix) {
        /* Caller already supplied the country code. */
        international = digits;
    } else if (digits.startsWith(callingCode)) {
        /* e.g. 6281234567890 */
        international = digits;
    } else if (digits.startsWith("0")) {
        /* e.g. 081234567890 → national trunk prefix */
        international =
            callingCode + digits.slice(1);
    } else if (digits.startsWith("8")) {
        /* e.g. 81234567890 → mobile without the trunk 0 */
        international = callingCode + digits;
    } else {
        /*
         * No country code and not an Indonesian trunk/prefix
         * shape. Guessing a country would hash to a value that
         * matches nobody, so drop it.
         */
        return null;
    }

    /*
     * Drop the national trunk 0 that sometimes follows an
     * already-international 62 prefix (+6208…, 6208…).
     */
    if (
        international.startsWith(callingCode) &&
        international.length > callingCode.length &&
        international.charAt(
            callingCode.length
        ) === "0"
    ) {
        international =
            callingCode +
            international.slice(
                callingCode.length + 1
            );
    }

    if (
        international.length >
        MAX_TIKTOK_MATCH_PHONE_DIGITS
    ) {
        return null;
    }

    if (
        international.length <
        MIN_TIKTOK_MATCH_PHONE_DIGITS
    ) {
        return null;
    }

    return `+${international}`;
}

/**
 * Build the RAW, normalized Advanced Matching payload for the
 * BROWSER Pixel (`ttq.identify()`).
 *
 * WHY RAW IS CORRECT HERE (verified, see PHASE_22 report):
 *   TikTok's browser Pixel hashes customer identifiers with
 *   SHA-256 CLIENT-SIDE before they reach TikTok servers. Passing
 *   an already-hashed digest would therefore be hashed a second
 *   time and match nobody. The documented contract for
 *   `ttq.identify()` is to hand over the normalized RAW value.
 *
 *   The SERVER-SIDE Events API is the opposite: it requires the
 *   SHA-256 digest, which is why `buildTikTokUserMatch()` below
 *   hashes and this function deliberately does not.
 *
 * Values are normalized with the EXACT same functions as the
 * server path so both channels describe the same person, and empty
 * / invalid keys are omitted rather than filled with a placeholder.
 */
export function buildTikTokBrowserMatch(
    input: TikTokUserMatchInput
): TikTokBrowserMatch {
    const match: TikTokBrowserMatch = {};

    const email = normalizeTikTokMatchEmail(
        input.email
    );

    if (email) {
        match.email = email;
    }

    const phone = normalizeTikTokMatchPhone(
        input.phone
    );

    if (phone) {
        /*
         * TikTok's browser Pixel names the key `phone_number`,
         * unlike the Events API's `phone`.
         */
        match.phone_number = phone;
    }

    if (typeof input.externalId === "string") {
        const externalId = input.externalId.trim();

        if (externalId) {
            match.external_id = externalId;
        }
    }

    return match;
}

/**
 * Raw Advanced Matching keys for the browser Pixel.
 *
 * The values are normalized but NOT hashed: the Pixel hashes them
 * client-side before they leave the browser.
 */
export type TikTokBrowserMatch = {
    email?: string;
    phone_number?: string;
    external_id?: string;
};

/** True when at least one browser match key was resolved. */
export function hasTikTokBrowserMatch(
    match: TikTokBrowserMatch | null | undefined
): boolean {
    if (!match) {
        return false;
    }

    return Boolean(
        match.email ||
            match.phone_number ||
            match.external_id
    );
}

/**
 * SHA-256 digest, lowercase hex — the only form TikTok accepts for
 * a pre-hashed identifier.
 *
 * Pure and deterministic: no salt, no key, no database. The input
 * is never logged.
 */
export function sha256TikTokMatch(
    value: string
): string {
    return createHash(
        TIKTOK_MATCH_HASH_ALGORITHM
    )
        .update(value, "utf8")
        .digest("hex");
}

/** SHA-256 of the normalized email, or null when unusable. */
export function hashTikTokMatchEmail(
    value: unknown
): string | null {
    const email =
        normalizeTikTokMatchEmail(value);

    return email
        ? sha256TikTokMatch(email)
        : null;
}

/** SHA-256 of the E.164 phone, or null when unusable. */
export function hashTikTokMatchPhone(
    value: unknown
): string | null {
    const phone =
        normalizeTikTokMatchPhone(value);

    return phone
        ? sha256TikTokMatch(phone)
        : null;
}

/** SHA-256 of the trimmed stable customer id, or null. */
export function hashTikTokMatchExternalId(
    value: unknown
): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const externalId = value.trim();

    return externalId
        ? sha256TikTokMatch(externalId)
        : null;
}

/**
 * Build the `user` match-key object for one customer.
 *
 * Every key is OPTIONAL and omitted when the app does not have a
 * usable value — never an empty string, never a null hash, never a
 * fabricated identifier. An input with nothing usable returns an
 * EMPTY object, which callers treat as "no matching data".
 */
export function buildTikTokUserMatch(
    input: TikTokUserMatchInput
): TikTokUserMatch {
    const match: TikTokUserMatch = {};

    const email = hashTikTokMatchEmail(
        input.email
    );

    if (email) {
        match.email = email;
    }

    const phone = hashTikTokMatchPhone(
        input.phone
    );

    if (phone) {
        match.phone = phone;
    }

    const externalId =
        hashTikTokMatchExternalId(
            input.externalId
        );

    if (externalId) {
        match.external_id = externalId;
    }

    return match;
}

/** True when at least one usable match key was resolved. */
export function hasTikTokUserMatch(
    match: TikTokUserMatch | null | undefined
): boolean {
    if (!match) {
        return false;
    }

    return Boolean(
        match.email ||
            match.phone ||
            match.external_id
    );
}
