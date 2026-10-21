/** Trusted admin-managed Meta Pixel base code helpers. */
export const MAX_META_PIXEL_CODE_LENGTH = 20_000;

export function normalizeMetaPixelCode(value: unknown): string {
    if (typeof value !== "string") return "";
    const code = value.trim();
    if (!code || code.length > MAX_META_PIXEL_CODE_LENGTH) return "";
    return code
        .replace(/<script\b[^>]*>/gi, "")
        .replace(/<\/script\s*>/gi, "")
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, "")
        .trim();
}

export function extractMetaPixelId(code: string): string | null {
    const matches = [...code.matchAll(/fbq\s*\(\s*['\"]init['\"]\s*,\s*['\"](\d{5,20})['\"]/gi)];
    const ids = [...new Set(matches.map((match) => match[1]))];
    return ids.length === 1 ? ids[0] : null;
}

export function stripMetaAutomaticPageView(code: string): string {
    return code.replace(/fbq\s*\(\s*['\"]track['\"]\s*,\s*['\"]PageView['\"]\s*\)\s*;?/gi, "");
}

export function normalizeMetaAccessToken(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const token = value.trim();
    if (!token || token.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(token)) return null;
    return token;
}

export function last4OfMetaAccessToken(value: string | null): string | null {
    return value && value.length >= 4 ? value.slice(-4) : null;
}
