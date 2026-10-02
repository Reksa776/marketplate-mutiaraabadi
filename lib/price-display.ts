/*
 * ============================================================
 * PRICE DISPLAY RULE — SINGLE SOURCE OF TRUTH (CLIENT-SAFE)
 * ============================================================
 *
 * `ProductVariant.price` is the authoritative SELL/base price.
 * `ProductVariant.comparePrice` ("Harga Normal") is DISPLAY-ONLY.
 *
 * HARD RULES:
 *   - comparePrice is NEVER used for checkout, payment, order
 *     totals, vouchers, affiliate or refund.
 *   - The actual price charged is `effectivePrice` (marketing
 *     pricing applied). `originalPrice` is the marketing base
 *     (= raw variant.price) and is only a fallback strikethrough.
 *
 * STRIKETHROUGH PRECEDENCE (exactly one struck price, ever):
 *   1. comparePrice != null AND comparePrice > effectivePrice
 *        → effectivePrice prominent, comparePrice struck.
 *   2. comparePrice <= effectivePrice → comparePrice not shown.
 *   3. comparePrice null → existing marketing display
 *        (originalPrice struck iff originalPrice > effectivePrice).
 *
 * This module is PURE (no prisma / no env), so it is safe to
 * import from client components AND from server code.
 * ============================================================
 */

export type PriceDisplaySource =
    | "COMPARE_PRICE"
    | "MARKETING"
    | "NONE";

export type PriceDisplayInput = {
    /** Actual price charged, after marketing pricing. */
    effectivePrice: number;
    /** Marketing base = raw ProductVariant.price. */
    originalPrice: number;
    /** DISPLAY-ONLY compare/list price (nullable). */
    comparePrice: number | null | undefined;
};

export type PriceDisplay = {
    /** Prominent price (always the actual charged price). */
    price: number;
    /** At most ONE struck-through price, or null. */
    strikethrough: number | null;
    source: PriceDisplaySource;
};

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/**
 * Resolve the single display rule. Never returns two strikethroughs.
 */
export function resolvePriceDisplay(
    input: PriceDisplayInput
): PriceDisplay {
    const effective = isFiniteNumber(input.effectivePrice)
        ? input.effectivePrice
        : 0;

    const original = isFiniteNumber(input.originalPrice)
        ? input.originalPrice
        : effective;

    // Rule 1 — explicit "Harga Normal" wins when it is higher.
    if (
        isFiniteNumber(input.comparePrice) &&
        input.comparePrice > effective
    ) {
        return {
            price: effective,
            strikethrough: input.comparePrice,
            source: "COMPARE_PRICE",
        };
    }

    // Rule 3 — fall back to the existing marketing strikethrough.
    if (original > effective) {
        return {
            price: effective,
            strikethrough: original,
            source: "MARKETING",
        };
    }

    // Rule 2 / no discount.
    return { price: effective, strikethrough: null, source: "NONE" };
}

/* ============================================================
 * comparePrice VALIDATION (server-authoritative)
 * ============================================================
 * Rules:
 *   - null / undefined / "" → null (no compare price)
 *   - numeric INTEGER rupiah only; reject float / NaN / Infinity
 *   - > 0
 *   - >= sell price
 */

export type ComparePriceParse =
    | { ok: true; value: number | null }
    | { ok: false; message: string };

export function parseComparePrice(
    raw: unknown,
    sellPrice: number
): ComparePriceParse {
    if (raw === null || raw === undefined || raw === "") {
        return { ok: true, value: null };
    }

    let value: number;

    if (typeof raw === "number") {
        value = raw;
    } else if (typeof raw === "string") {
        const trimmed = raw.trim();

        if (!/^\d+$/.test(trimmed)) {
            return {
                ok: false,
                message:
                    "Harga normal harus berupa angka bulat (tanpa desimal).",
            };
        }

        value = Number(trimmed);
    } else {
        return {
            ok: false,
            message: "Harga normal tidak valid.",
        };
    }

    if (!Number.isFinite(value)) {
        return { ok: false, message: "Harga normal tidak valid." };
    }

    if (!Number.isInteger(value)) {
        return {
            ok: false,
            message:
                "Harga normal harus bilangan bulat (tanpa desimal).",
        };
    }

    if (value <= 0) {
        return {
            ok: false,
            message: "Harga normal harus lebih dari 0.",
        };
    }

    if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
        return { ok: false, message: "Harga jual tidak valid." };
    }

    if (value < sellPrice) {
        return {
            ok: false,
            message:
                "Harga normal tidak boleh lebih kecil dari harga jual.",
        };
    }

    return { ok: true, value };
}

/** Persist-safe form: validated value, or null when unset/invalid. */
export function normalizeComparePrice(
    raw: unknown,
    sellPrice: number
): number | null {
    const parsed = parseComparePrice(raw, sellPrice);
    return parsed.ok ? parsed.value : null;
}
