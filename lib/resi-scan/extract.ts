/* ==========================================
 * RESI SCAN — FIELD EXTRACTION
 * ==========================================
 *
 * Heuristic extraction of the order reference
 * and tracking number from normalized document
 * text (PDF text or OCR output).
 *
 * Supported label variants (Indonesian label +
 * common English forms) are matched after
 * whitespace normalization. OCR typos (O/0,
 * I/1, S/5) are NOT corrected: a false positive
 * here would mis-assign a resi, so we prefer a
 * clean miss (LOW / needs review) over a wrong
 * match.
 */

import {
    cleanCandidateToken,
    escapeRegExp,
    normalizeText,
} from "./normalize";

export const ORDER_NUMBER_PATTERN =
    /\b(?:ORD|PAY-BN|PAY-CART)-\d{10,18}-[0-9A-Fa-f]{8}\b/;

const ORDER_LABELS = [
    "no. pesanan",
    "nomor pesanan",
    "order number",
    "no. order",
    "nomor order",
    "no order",
    "order id",
    "id order",
    "order no",
    "invoice number",
    "invoice no",
    "invoice",
    "order",
    "pesanan",
].sort((a, b) => b.length - a.length);

const TRACKING_LABELS = [
    "no. resi",
    "nomor resi pengiriman",
    "no. resi pengiriman",
    "nomor resi",
    "no resi",
    "resi pengiriman",
    "tracking number",
    "tracking no",
    "nomor tracking",
    "no. tracking",
    "tracking id",
    "no. awb",
    "no awb",
    "nomor awb",
    "kode resi",
    "awb",
    "resi",
    "tracking",
].sort((a, b) => b.length - a.length);

function extractAfterLabels(
    text: string,
    labels: string[]
): string | null {
    const oneLine = normalizeText(text);

    for (const label of labels) {
        const esc = escapeRegExp(label);
        const regex = new RegExp(
            `\\b${esc}\\s*:?\\s*([^\\s,;)]+)`,
            "i"
        );

        const match = oneLine.match(regex);
        if (!match) continue;

        const token = cleanCandidateToken(match[1]);
        if (!token) continue;

        // A plausible value must contain a digit.
        if (!/\d/.test(token)) continue;

        return token;
    }

    return null;
}

/**
 * Prefer an explicit order-number token anywhere
 * in the document (e.g. "ORD-1745012345678-abc12345"),
 * otherwise fall back to label-based extraction.
 */
export function extractOrderReference(
    text: string
): string | null {
    const oneLine = normalizeText(text);

    const direct = oneLine.match(ORDER_NUMBER_PATTERN);
    if (direct) {
        return direct[0].toUpperCase();
    }

    const token = extractAfterLabels(
        oneLine,
        ORDER_LABELS
    );
    if (!token) return null;

    // Only accept tokens that look like an order
    // reference (order number pattern, existing
    // prefix, or a short numeric id).
    if (
        ORDER_NUMBER_PATTERN.test(token) ||
        /^\d{1,9}$/.test(token) ||
        /^(ORD|PAY-BN|PAY-CART)-/i.test(token)
    ) {
        return token.toUpperCase();
    }

    return null;
}

/**
 * Must be a plausible courier tracking number:
 *   - 8..40 chars of [A-Z0-9._-]
 *   - not an order-number token
 *   - not a phone number / date-like all-digit value
 *   - contains a letter, or is long enough to be
 *     a numeric airwaybill (>= 10 digits)
 */
export function isPlausibleTrackingNumber(
    value: string
): boolean {
    // Strict: trim + uppercase only. We do NOT strip
    // punctuation here — extraction callers have
    // already cleaned their candidates; the APPLY
    // path must never let characters outside
    // [A-Z0-9._-] pass, otherwise the uncleaned value
    // could be persisted (e.g. "RESI-LAIN!!").
    const token = value?.trim().toUpperCase() ?? "";
    if (!token || token !== token.toUpperCase()) {
        return false;
    }

    if (token.length < 8 || token.length > 40) {
        return false;
    }

    if (!/^[A-Z0-9._-]+$/.test(token)) {
        return false;
    }

    if (/^(ORD|PAY-BN|PAY-CART)-/i.test(token)) {
        return false;
    }

    // Reject repeated single character ("AAAAAAAA").
    if (/^(.)\1+$/.test(token)) {
        return false;
    }

    // Must carry a letter, or be a long numeric
    // airwaybill (>= 10 digits). Short numerics are
    // order ids / dates / phones, never resi.
    const hasLetter = /[A-Z]/.test(token);
    if (!hasLetter) {
        const digitCount = token.replace(/[^0-9]/g, "").length;
        if (digitCount < 10) return false;
    }

    return true;
}

export function extractTrackingNumber(
    text: string
): string | null {
    const oneLine = normalizeText(text);
    const token = extractAfterLabels(
        oneLine,
        TRACKING_LABELS
    );
    if (!token) return null;

    return isPlausibleTrackingNumber(token)
        ? token.toUpperCase()
        : null;
}

export function extractFields(text: string): {
    orderReference: string | null;
    trackingNumber: string | null;
} {
    return {
        orderReference: extractOrderReference(text),
        trackingNumber: extractTrackingNumber(text),
    };
}