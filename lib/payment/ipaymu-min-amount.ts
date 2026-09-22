/**
 * ==========================================
 * IPAYMU MINIMUM AMOUNT RULE
 * ==========================================
 *
 * iPaymu rejects any payment below Rp10.000 (HTTP 400:
 * "amount harus minimal 10000"). Only QRIS accepts an amount below
 * the threshold, so every other iPaymu method (Bank Transfer / VA,
 * E-Wallet) must be blocked — both in the UI and on the server
 * BEFORE the provider is called.
 *
 * This module is the SINGLE source of truth for the rule. It is
 * deliberately dependency-free so BOTH server routes AND the
 * "use client" checkout pages can import it without pulling any
 * server-only code into the browser bundle.
 *
 * Enforcement (see the routes / order-payment):
 *  - CART + BUY NOW use the server-computed grossAmount
 *  - REPAY uses the persisted order total from the DB
 *  - a provider HTTP 400 with the Indonesian message is also
 *    normalized back to this same error as a safety net
 */

/** iPaymu rejects priced payments below this amount. */
export const IPAYMU_MIN_AMOUNT = 10000;

/** Machine-readable error code returned to clients. */
export const IPAYMU_MIN_AMOUNT_CODE = "IPAYMU_MIN_AMOUNT";

/** User-facing reason shown in the API response / toast. */
export const IPAYMU_MIN_AMOUNT_MESSAGE =
    "Metode pembayaran ini belum tersedia untuk transaksi di bawah Rp10.000.";

/** User-facing actionable hint. */
export const IPAYMU_MIN_AMOUNT_SUGGESTION =
    "Silakan gunakan QRIS atau tambah total belanja menjadi minimal Rp10.000.";

/** Combined friendly text used for single-line toasts. */
export const IPAYMU_MIN_AMOUNT_FULL_MESSAGE = `${IPAYMU_MIN_AMOUNT_MESSAGE} ${IPAYMU_MIN_AMOUNT_SUGGESTION}`;

/** Short lock note displayed next to disabled methods in the UI. */
export const IPAYMU_MIN_AMOUNT_UI_NOTE = "Minimal transaksi Rp10.000";

export type IpaymuMethod = "BANK_TRANSFER" | "E_WALLET" | "QRIS";

export function isIpaymuQris(
    method: string | undefined | null
): boolean {
    return method === "QRIS";
}

/**
 * True when `amount` may be charged to iPaymu using `method`.
 *
 * - amount >= Rp10.000  → always allowed
 * - amount <  Rp10.000  → allowed only for QRIS
 */
export function isIpaymuAmountAllowed(
    amount: number,
    method: string | undefined | null
): boolean {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric < IPAYMU_MIN_AMOUNT) {
        return isIpaymuQris(method);
    }
    return true;
}

/**
 * Thrown when an order below the minimum is paired with a non-QRIS
 * method. Backend call-sites catch this and answer with a
 * structured, machine-readable error ({ code, message, detail }).
 */
export class IpaymuMinAmountError extends Error {
    readonly code = IPAYMU_MIN_AMOUNT_CODE;
    readonly status = 400;
    readonly suggestion = IPAYMU_MIN_AMOUNT_SUGGESTION;
    readonly amount: number;
    readonly method: string;

    constructor(amount?: number, method?: string) {
        super(IPAYMU_MIN_AMOUNT_FULL_MESSAGE);
        this.name = "IpaymuMinAmountError";
        this.amount = amount ?? 0;
        this.method = method ?? "";
    }
}

export function isIpaymuMinAmountError(
    error: unknown
): error is IpaymuMinAmountError {
    return (
        error instanceof Error &&
        (error as { code?: unknown }).code === IPAYMU_MIN_AMOUNT_CODE
    );
}

/**
 * Detect the provider's own minimum-amount rejection text and
 * normalize it to the same structured error the pre-check would have
 * returned.
 *
 * Matching is case-insensitive and tolerant of separators/formatting
 * so "amount harus minimal 10000", "AMOUNT HARUS MINIMAL 10000" and
 * "amount harus minimal 10.000" all match. Returns null when the
 * message is unrelated.
 */
export function detectIpaymuMinAmountMessage(
    message: unknown
): {
    code: typeof IPAYMU_MIN_AMOUNT_CODE;
    message: string;
    detail: string;
} | null {
    if (typeof message !== "string" || message.trim() === "") {
        return null;
    }

    const compact = message.toLowerCase().replace(/[\s.,\-_]+/g, "");

    const matched =
        /amountharusminimal\d{4,}/.test(compact) ||
        /harusminimal\d{4,}/.test(compact) ||
        /minimaltransaksi\d{4,}/.test(compact);

    if (!matched) return null;

    return {
        code: IPAYMU_MIN_AMOUNT_CODE,
        message: IPAYMU_MIN_AMOUNT_MESSAGE,
        detail: IPAYMU_MIN_AMOUNT_SUGGESTION,
    };
}