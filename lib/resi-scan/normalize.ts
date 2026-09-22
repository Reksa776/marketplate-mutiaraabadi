/* ==========================================
 * RESI SCAN — TEXT NORMALIZATION
 * ==========================================
 *
 * Text cleaning shared by both the PDF and OCR
 * paths. Deliberately conservative: we collapse
 * whitespace and unify unicode punctuation, but
 * we do NOT aggressively "fix" OCR typos. A
 * wrong "correction" on a resi would silently
 * break tracking, so we prefer false negatives
 * over false positives.
 */

const SPACE_RUN = /[\s\u00a0\u202f\u2009]+/g;

export function normalizeText(text: string): string {
    return text
        .replace(SPACE_RUN, " ")
        .trim();
}

/**
 * Normalize a single line for label matching:
 * lowercase, collapse inner whitespace, drop
 * surrounding punctuation/quotes.
 */
export function normalizeLabelText(value: string): string {
    return normalizeText(value)
        .replace(/[“”"‘’'`]/g, "")
        .toLowerCase();
}

export function uppercaseToken(value: string): string {
    return normalizeText(value)
        .replace(/[“”"‘’'`¿¡]/g, "")
        .toUpperCase();
}

/**
 * Collapse a candidate into a matchable token:
 * removes trailing punctuation but preserves
 * internal letters/digits (and -._ for courier
 * resi variants). No typo substitution.
 */
export function cleanCandidateToken(value: string): string {
    return uppercaseToken(value)
        .replace(/^[^A-Z0-9.-]+/, "")
        .replace(/[^A-Z0-9.-]+$/, "");
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}