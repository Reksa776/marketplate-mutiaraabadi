/**
 * ==========================================
 * CHECKOUT PRICE BASELINE — NORMAL → MARKETING → FINAL
 * ==========================================
 *
 * Business rule under guard:
 *
 *   Harga Normal  →  Marketing override (if active)  →  Final price
 *
 *   - `ProductVariant.price` ("Harga Normal") is the marketing base.
 *   - Marketing (product discount / flash sale / campaign / bulk) is
 *     applied to that base.
 *   - A lower display-only value (e.g. a "selling" teaser) is NEVER
 *     used as the marketing base and never becomes the final price.
 *
 * These tests exercise the REAL `resolveBatchPrices` engine with a
 * mocked Prisma layer. No order, payment or DB write happens.
 *
 * Run: npx jest __tests__/marketing/checkout-price-baseline.test.ts
 */

const mockPrisma = {
    flashSale: { findMany: jest.fn() },
    productDiscount: { findMany: jest.fn() },
    bulkDiscount: { findMany: jest.fn() },
    campaign: { findMany: jest.fn(), findUnique: jest.fn() },
};

jest.mock("@/lib/prisma", () => ({
    prisma: mockPrisma,
}));

import { resolveBatchPrices } from "@/lib/marketing/batch-pricing";

function decimal(value: number) {
    return {
        toString: () => String(value),
        valueOf: () => value,
    } as any;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.flashSale.findMany.mockResolvedValue([]);
    mockPrisma.productDiscount.findMany.mockResolvedValue([]);
    mockPrisma.campaign.findMany.mockResolvedValue([]);
    mockPrisma.bulkDiscount.findMany.mockResolvedValue([]);
});

describe("Harga Normal → Marketing → Final price", () => {
    /*
     * CASE 1
     * Harga Normal = 20.000, a lower "selling" display = 17.500,
     * no marketing.
     * Expected checkout baseline: 20.000 (the Harga Normal).
     */
    test("CASE 1: no marketing → final price equals the Harga Normal", async () => {
        const results = await resolveBatchPrices([
            {
                productId: 1,
                variantId: 1,
                originalPrice: 20000,
                quantity: 1,
            },
        ]);

        expect(results[0].effectivePrice).toBe(20000);
        expect(results[0].discountAmount).toBe(0);
        expect(results[0].source).toBe("ORIGINAL");
    });

    /*
     * CASE 2
     * Harga Normal = 20.000, Marketing = -10%.
     * Expected: 18.000 — i.e. 10% OFF THE NORMAL PRICE.
     * NOT 17.500 − 10%, and NOT 17.500.
     */
    test("CASE 2: marketing -10% → 18.000 (applied to 20.000 base)", async () => {
        mockPrisma.productDiscount.findMany.mockResolvedValue([
            {
                productId: 1,
                variantId: 1,
                type: "PERCENTAGE",
                value: decimal(10),
                maxDiscount: null,
            },
        ]);

        const results = await resolveBatchPrices([
            {
                productId: 1,
                variantId: 1,
                originalPrice: 20000,
                quantity: 1,
            },
        ]);

        expect(results[0].effectivePrice).toBe(18000);
        expect(results[0].discountAmount).toBe(2000);
        expect(results[0].source).toBe("PRODUCT_DISCOUNT");
    });

    /*
     * CASE 3
     * Harga Normal = 20.000, Marketing = fixed 15.000 final.
     * The existing engine models "fixed" as a fixed-amount discount,
     * so a fixed Rp5.000 discount on the 20.000 base yields 15.000.
     */
    test("CASE 3: marketing fixed amount (Rp5.000 off) → 15.000", async () => {
        mockPrisma.productDiscount.findMany.mockResolvedValue([
            {
                productId: 1,
                variantId: 1,
                type: "FIXED",
                value: decimal(5000),
                maxDiscount: null,
            },
        ]);

        const results = await resolveBatchPrices([
            {
                productId: 1,
                variantId: 1,
                originalPrice: 20000,
                quantity: 1,
            },
        ]);

        expect(results[0].effectivePrice).toBe(15000);
        expect(results[0].discountAmount).toBe(5000);
        expect(results[0].source).toBe("PRODUCT_DISCOUNT");
    });

    /*
     * The marketing base is the input `originalPrice` — which callers
     * populate from `ProductVariant.price` ("Harga Normal"). A stray
     * lower "selling"/"display" value smuggled into the item must NOT
     * influence the marketing math.
     */
    test("marketing base is the Harga Normal, never a lower teaser price", async () => {
        mockPrisma.productDiscount.findMany.mockResolvedValue([
            {
                productId: 1,
                variantId: 1,
                type: "PERCENTAGE",
                value: decimal(10),
                maxDiscount: null,
            },
        ]);

        const results = await resolveBatchPrices([
            {
                productId: 1,
                variantId: 1,
                originalPrice: 20000,
                quantity: 1,
                // Deliberately bogus fields a caller might smuggle in.
                sellingPrice: 17500,
                displayPrice: 17500,
                comparePrice: 30000,
            } as any,
        ]);

        // 10% of 20.000 = 18.000 — not 10% of 17.500.
        expect(results[0].effectivePrice).toBe(18000);
    });

    test("marketing base is reported as the Harga Normal in originalPrice", async () => {
        const results = await resolveBatchPrices([
            {
                productId: 1,
                variantId: 1,
                originalPrice: 20000,
                quantity: 1,
            },
        ]);

        expect(results[0].originalPrice).toBe(20000);
    });
});
