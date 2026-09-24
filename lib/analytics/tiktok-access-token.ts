/**
 * ==========================================
 * TIKTOK PIXEL ACCESS TOKEN (HELPERS)
 * ==========================================
 *
 * The Access Token is the credential for the server-side
 * TikTok Events API. It is a SECRET:
 *
 *   - it is only ever written by an ADMIN via Pengaturan Toko
 *   - it is never returned by any API response
 *   - it is never sent to the browser / storefront
 *   - it is never included in the browser pixel config
 *
 * This module only holds pure string helpers (normalize,
 * mask, last-4). It never reads the database and never makes
 * a request, so it is safe to import from server code.
 */

/** Upper bound to reject absurd payloads (TikTok tokens are far shorter). */
export const MAX_TIKTOK_PIXEL_ACCESS_TOKEN_LENGTH = 2048;

/**
 * Normalize a raw Access Token value coming from the admin.
 *
 * Mengembalikan token yang sudah di-trim, atau null kalau
 * nilainya kosong / bukan string / terlalu panjang / memuat
 * karakter kontrol (spasi, newline, dsb.).
 */
export function normalizeTikTokPixelAccessToken(
    value: unknown
): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const token = value.trim();

    if (!token) {
        return null;
    }

    if (
        token.length >
        MAX_TIKTOK_PIXEL_ACCESS_TOKEN_LENGTH
    ) {
        return null;
    }

    // Tokens must be a single opaque line — no whitespace or
    // control characters anywhere.
    if (/[\s\u0000-\u001f\u007f]/.test(token)) {
        return null;
    }

    return token;
}

/**
 * Last 4 characters of a stored token, for a non-reversible hint
 * in the admin UI. Never exposes enough to reconstruct the token.
 */
export function last4OfTikTokAccessToken(
    token: string | null | undefined
): string | null {
    if (typeof token !== "string") {
        return null;
    }

    const trimmed = token.trim();

    if (trimmed.length < 4) {
        return null;
    }

    return trimmed.slice(-4);
}

/**
 * Masked display value: `••••abcd`.
 */
export function maskTikTokAccessToken(
    token: string | null | undefined
): string | null {
    const last4 = last4OfTikTokAccessToken(token);

    return last4 ? `••••${last4}` : null;
}
