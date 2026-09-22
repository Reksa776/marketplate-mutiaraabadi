/* ==========================================
 * REFUND — DESTINATION BANK VALIDATION + MASKING
 * ==========================================
 *
 * Shared by the customer refund request route and
 * the admin refund UI. Bank data is sensitive:
 * account numbers are masked everywhere except the
 * admin refund panel (where the masked value is
 * always shown by default and can be revealed).
 */

export interface BankValidation {
    ok: boolean;
    error?: string;
    bankName?: string;
    bankAccountName?: string;
    bankAccountNumber?: string;
}

const BANK_NAME_MAX = 60;
const ACCOUNT_NAME_MAX = 100;
const ACCOUNT_NUMBER_MAX = 30;

export function maskAccountNumber(
    value: string
): string {
    const digits = value.replace(/\D/g, "");
    if (digits.length <= 4) {
        return "****";
    }
    return "****" + digits.slice(-4);
}

export function validateBankFields(
    bankName?: string | null,
    bankAccountName?: string | null,
    bankAccountNumber?: string | null
): BankValidation {
    const name = bankName?.trim() ?? "";
    const holder = bankAccountName?.trim() ?? "";
    const number = bankAccountNumber?.trim() ?? "";

    if (!name) {
        return {
            ok: false,
            error: "Nama bank wajib diisi.",
        };
    }

    if (name.length > BANK_NAME_MAX) {
        return {
            ok: false,
            error: `Nama bank maksimal ${BANK_NAME_MAX} karakter.`,
        };
    }

    if (/[<>&"']/.test(name)) {
        return {
            ok: false,
            error: "Nama bank mengandung karakter tidak valid.",
        };
    }

    if (!holder) {
        return {
            ok: false,
            error: "Nama pemilik rekening wajib diisi.",
        };
    }

    if (holder.length > ACCOUNT_NAME_MAX) {
        return {
            ok: false,
            error: `Nama pemilik rekening maksimal ${ACCOUNT_NAME_MAX} karakter.`,
        };
    }

    if (/[<>&"'/\\]/.test(holder)) {
        return {
            ok: false,
            error: "Nama pemilik rekening mengandung karakter tidak valid.",
        };
    }

    if (!number) {
        return {
            ok: false,
            error: "Nomor rekening wajib diisi.",
        };
    }

    if (!/^[\d\s-]{6,}$/.test(number)) {
        return {
            ok: false,
            error: "Nomor rekening tidak valid.",
        };
    }

    const normalizedNumber = number.replace(/[\s-]/g, "");
    if (normalizedNumber.length < 6) {
        return {
            ok: false,
            error: "Nomor rekening tidak valid.",
        };
    }

    if (normalizedNumber.length > ACCOUNT_NUMBER_MAX) {
        return {
            ok: false,
            error: `Nomor rekening maksimal ${ACCOUNT_NUMBER_MAX} digit.`,
        };
    }

    if (!/^\d+$/.test(normalizedNumber)) {
        return {
            ok: false,
            error: "Nomor rekening hanya boleh berupa angka.",
        };
    }

    return {
        ok: true,
        bankName: name,
        bankAccountName: holder,
        bankAccountNumber: normalizedNumber,
    };
}