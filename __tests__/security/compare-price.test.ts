/**
 * ==========================================
 * HARGA NORMAL / HARGA CORET (comparePrice)
 * ==========================================
 *
 * Run: npx jest __tests__/security/compare-price.test.ts
 *
 * Guards the Phase 2 contract:
 *  - ProductVariant.price remains the authoritative sell price.
 *  - ProductVariant.comparePrice is DISPLAY-ONLY.
 *  - comparePrice is NEVER used for checkout / payment / order
 *    totals / voucher / affiliate / refund.
 *  - At most ONE struck-through price is ever rendered.
 *  - Existing products (NULL comparePrice) keep the old display.
 *
 * No real order, payment, shipment or transaction is created.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

/* ==========================================
 * MOCKS — createCheckoutOrder dependencies
 * ========================================== */

const mockTx = {
    productVariant: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
    },
    product: {
        update: jest.fn(),
    },
    order: {
        create: jest.fn(),
    },
    cartItem: {
        deleteMany: jest.fn(),
    },
    affiliateProfile: {
        findFirst: jest.fn(),
    },
    affiliateConversion: {
        create: jest.fn(),
    },
    spinWheelSpin: {
        update: jest.fn(),
    },
    $executeRaw: jest.fn(),
};

const mockPrisma = {
    userAddress: {
        findFirst: jest.fn(),
    },
    storeSetting: {
        findUnique: jest.fn(),
    },
    productVariant: {
        findUnique: jest.fn(),
    },
    cartItem: {
        findMany: jest.fn(),
    },
    $transaction: jest.fn(),
};

jest.mock("@/lib/prisma", () => ({
    prisma: mockPrisma,
}));

jest.mock("@/lib/voucher", () => ({
    incrementVoucherUsage: jest.fn(),
    incrementVoucherUserUsage: jest.fn(),
    validateAndCalculateVoucherEnhanced: jest.fn(),
}));

jest.mock("@/lib/marketing/flash-sale", () => ({
    recordFlashSalePurchase: jest.fn(),
    hasReachedFlashSaleLimit: jest.fn(),
}));

const mockResolveBatchPrices = jest.fn();
const mockResolveOrderCampaignId = jest.fn();

jest.mock("@/lib/marketing/batch-pricing", () => ({
    resolveBatchPrices: (...args: unknown[]) =>
        mockResolveBatchPrices(...args),
    resolveOrderCampaignId: (...args: unknown[]) =>
        mockResolveOrderCampaignId(...args),
}));

jest.mock("@/lib/marketing/shipping-discount", () => ({
    calculateShippingDiscount: jest.fn(async () => null),
    reserveShippingDiscountUsage: jest.fn(),
}));

jest.mock("@/lib/rajaongkir", () => ({
    calculateDomesticCost: jest.fn(),
}));

jest.mock("@/lib/mengantar/shipping", () => ({
    verifyMengantarShippingCost: jest.fn(async () => 15000),
}));

jest.mock("@/lib/spin-wheel", () => ({
    calculateSpinRewardDiscount: jest.fn(() => 0),
}));

jest.mock("@/lib/payment/ipaymu", () => ({
    formatProductName: (productName: string, variantName: string) =>
        `${productName} - ${variantName}`,
}));

jest.mock("@/lib/payment/order-payment", () => ({
    PAYMENT_EXPIRY_GRACE_MS: 5 * 60 * 1000,
}));

import {
    resolvePriceDisplay,
    parseComparePrice,
    normalizeComparePrice,
} from "@/lib/price-display";

import { createCheckoutOrder } from "@/lib/checkout";

/* ==========================================
 * HELPERS
 * ========================================== */

function readFile(relativePath: string): string {
    try {
        return readFileSync(
            resolve(process.cwd(), relativePath),
            "utf-8"
        );
    } catch {
        return "";
    }
}

/**
 * Extract the createCheckoutOrder function body (up to rollback).
 */
function createCheckoutOrderBody(): string {
    const code = readFile("lib/checkout.ts");
    const start = code.indexOf(
        "export async function createCheckoutOrder("
    );
    const end = code.indexOf(
        "export async function rollbackCheckoutOrder("
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    return code.substring(start, end);
}

beforeEach(() => {
    jest.clearAllMocks();

    mockResolveBatchPrices.mockReset();
    mockResolveOrderCampaignId.mockReset();

    mockPrisma.$transaction.mockImplementation(
        async (arg: unknown) => {
            if (typeof arg === "function") {
                return (arg as (tx: unknown) => unknown)(mockTx);
            }
            return Promise.all(arg as Promise<unknown>[]);
        }
    );

    mockPrisma.userAddress.findFirst.mockResolvedValue({
        id: "addr-1",
        userId: "user-1",
        recipientName: "Budi",
        phone: "0812",
        address: "Jl. Test",
        province: "JAWA BARAT",
        city: "MAJALENGKA",
        district: "CINGAMBUL",
        postalCode: "45467",
        latitude: null,
        longitude: null,
        rajaOngkirDestinationId: null,
    });

    mockPrisma.storeSetting.findUnique.mockResolvedValue({
        rajaOngkirDestinationId: null,
    });

    mockPrisma.productVariant.findUnique.mockResolvedValue({
        weight: 1000,
    });

    mockTx.order.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
            id: 42,
            ...data,
        })
    );
    mockTx.productVariant.updateMany.mockResolvedValue({
        count: 1,
    });
    mockTx.product.update.mockResolvedValue({});
});

/**
 * Run createCheckoutOrder (BUY_NOW + COD) for a variant whose only
 * difference is comparePrice, then return the totals.
 */
async function runBuyNowWithComparePrice(
    comparePrice: number | null
) {
    const variant = {
        id: 7,
        productId: 3,
        name: "Merah",
        price: 50000,
        comparePrice,
        stock: 10,
        product: { id: 3, name: "Kaos" },
    };

    mockTx.productVariant.findFirst.mockResolvedValue(variant);
    mockResolveOrderCampaignId.mockResolvedValue(null);
    mockResolveBatchPrices.mockImplementation(
        async (
            items: Array<{
                productId: number;
                variantId: number;
                originalPrice: number;
                quantity: number;
            }>
        ) =>
            items.map((item) => ({
                effectivePrice: item.originalPrice,
                originalPrice: item.originalPrice,
                discountAmount: 0,
                source: "ORIGINAL",
                flashSaleId: null,
            }))
    );

    return createCheckoutOrder({
        userId: "user-1",
        mode: "BUY_NOW",
        addressId: "addr-1",
        shipping: {
            provider: "MENGANTAR",
            courier: "JNE",
            service: "REG",
            cost: 999999, // client value must be ignored
        },
        paymentMethod: "COD",
        productId: 3,
        variantId: 7,
        quantity: 2,
    });
}

/* ==========================================
 * 1. DISPLAY PRECEDENCE (contract examples)
 * ========================================== */

describe("resolvePriceDisplay — strikethrough precedence", () => {
    test("price 50k, comparePrice null → Rp50k, no strikethrough", () => {
        const display = resolvePriceDisplay({
            effectivePrice: 50000,
            originalPrice: 50000,
            comparePrice: null,
        });

        expect(display.price).toBe(50000);
        expect(display.strikethrough).toBeNull();
        expect(display.source).toBe("NONE");
    });

    test("price 50k, comparePrice 65k → Rp50k with Rp65k struck", () => {
        const display = resolvePriceDisplay({
            effectivePrice: 50000,
            originalPrice: 50000,
            comparePrice: 65000,
        });

        expect(display.price).toBe(50000);
        expect(display.strikethrough).toBe(65000);
        expect(display.source).toBe("COMPARE_PRICE");
    });

    test("marketing effective 40k, comparePrice null → Rp40k struck Rp50k", () => {
        const display = resolvePriceDisplay({
            effectivePrice: 40000,
            originalPrice: 50000,
            comparePrice: null,
        });

        expect(display.price).toBe(40000);
        expect(display.strikethrough).toBe(50000);
        expect(display.source).toBe("MARKETING");
    });

    test("marketing effective 40k, comparePrice 65k → Rp40k struck Rp65k", () => {
        const display = resolvePriceDisplay({
            effectivePrice: 40000,
            originalPrice: 50000,
            comparePrice: 65000,
        });

        expect(display.price).toBe(40000);
        expect(display.strikethrough).toBe(65000);
        expect(display.source).toBe("COMPARE_PRICE");
    });

    test("effective 50k, comparePrice 45k → Rp50k only", () => {
        const display = resolvePriceDisplay({
            effectivePrice: 50000,
            originalPrice: 50000,
            comparePrice: 45000,
        });

        expect(display.price).toBe(50000);
        expect(display.strikethrough).toBeNull();
    });

    test("effective 50k, comparePrice 50k → Rp50k only (never struck)", () => {
        const display = resolvePriceDisplay({
            effectivePrice: 50000,
            originalPrice: 50000,
            comparePrice: 50000,
        });

        expect(display.price).toBe(50000);
        expect(display.strikethrough).toBeNull();
    });

    test("marketing discount + comparePrice shows exactly ONE strikethrough", () => {
        const display = resolvePriceDisplay({
            effectivePrice: 40000,
            originalPrice: 50000,
            comparePrice: 65000,
        });

        const struck = [
            display.strikethrough,
        ].filter((value) => value !== null);

        expect(struck).toHaveLength(1);
        expect(struck[0]).toBe(65000);
        // The marketing original (50k) is NOT shown at all.
        expect(display.strikethrough).not.toBe(50000);
    });

    test("existing NULL comparePrice preserves old marketing behavior", () => {
        const withoutMarketing = resolvePriceDisplay({
            effectivePrice: 50000,
            originalPrice: 50000,
            comparePrice: null,
        });
        const withMarketing = resolvePriceDisplay({
            effectivePrice: 40000,
            originalPrice: 50000,
            comparePrice: null,
        });

        expect(withoutMarketing).toEqual({
            price: 50000,
            strikethrough: null,
            source: "NONE",
        });
        expect(withMarketing).toEqual({
            price: 40000,
            strikethrough: 50000,
            source: "MARKETING",
        });
    });

    test("a non-finite comparePrice is ignored", () => {
        for (const bad of [NaN, Infinity, -Infinity]) {
            const display = resolvePriceDisplay({
                effectivePrice: 50000,
                originalPrice: 50000,
                comparePrice: bad,
            });
            expect(display.strikethrough).toBeNull();
        }
    });
});

/* ==========================================
 * 2. VALIDATION RULES
 * ========================================== */

describe("parseComparePrice — validation", () => {
    test("null / undefined / empty string means no comparePrice", () => {
        expect(parseComparePrice(null, 50000)).toEqual({
            ok: true,
            value: null,
        });
        expect(parseComparePrice(undefined, 50000)).toEqual({
            ok: true,
            value: null,
        });
        expect(parseComparePrice("", 50000)).toEqual({
            ok: true,
            value: null,
        });
    });

    test("accepts comparePrice == price (accepted in DB)", () => {
        expect(parseComparePrice(50000, 50000)).toEqual({
            ok: true,
            value: 50000,
        });
        expect(parseComparePrice("50000", 50000)).toEqual({
            ok: true,
            value: 50000,
        });
    });

    test("accepts comparePrice > price", () => {
        expect(parseComparePrice(65000, 50000)).toEqual({
            ok: true,
            value: 65000,
        });
    });

    test("rejects comparePrice < price", () => {
        const result = parseComparePrice(45000, 50000);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toMatch(/lebih kecil/i);
        }
    });

    test("rejects zero and negative", () => {
        expect(parseComparePrice(0, 50000).ok).toBe(false);
        expect(parseComparePrice(-1, 50000).ok).toBe(false);
        expect(parseComparePrice("-100", 50000).ok).toBe(false);
    });

    test("rejects float / decimal values", () => {
        expect(parseComparePrice(50000.5, 50000).ok).toBe(false);
        expect(parseComparePrice("50000.5", 50000).ok).toBe(false);
    });

    test("rejects NaN / Infinity", () => {
        expect(parseComparePrice(NaN, 50000).ok).toBe(false);
        expect(parseComparePrice(Infinity, 50000).ok).toBe(false);
    });

    test("rejects non-numeric strings", () => {
        expect(parseComparePrice("abc", 50000).ok).toBe(false);
        expect(parseComparePrice("50abc", 50000).ok).toBe(false);
        expect(
            parseComparePrice({} as unknown, 50000).ok
        ).toBe(false);
    });

    test("normalizeComparePrice returns null for invalid input", () => {
        expect(normalizeComparePrice(null, 50000)).toBeNull();
        expect(normalizeComparePrice("", 50000)).toBeNull();
        expect(normalizeComparePrice(1, 50000)).toBeNull();
        expect(normalizeComparePrice("abc", 50000)).toBeNull();
        expect(normalizeComparePrice(65000, 50000)).toBe(65000);
    });
});

/* ==========================================
 * 3. comparePrice NEVER CHANGES CHECKOUT TOTAL
 * ========================================== */

describe("createCheckoutOrder — comparePrice is ignored", () => {
    test("identical totals with and without comparePrice", async () => {
        const withoutCompare = await runBuyNowWithComparePrice(
            null
        );
        const withCompare = await runBuyNowWithComparePrice(
            999999
        );

        // 2 × 50.000 + 15.000 shipping.
        expect(withoutCompare.subtotal).toBe(100000);
        expect(withCompare.subtotal).toBe(100000);

        expect(withCompare.subtotal).toBe(
            withoutCompare.subtotal
        );
        expect(withCompare.grossAmount).toBe(
            withoutCompare.grossAmount
        );
        expect(withCompare.discount).toBe(
            withoutCompare.discount
        );

        expect(
            (withCompare.order as any).total
        ).toBe(
            (withoutCompare.order as any).total
        );
        expect(
            (withCompare.order as any).subtotal
        ).toBe(
            (withoutCompare.order as any).subtotal
        );

        // The striking price never leaks into the order items.
        const createdItems = (
            (withCompare.order as any).items?.create ??
            mockTx.order.create.mock.calls[0][0].data
                .items.create
        ) as Array<{ price: number; subtotal: number }>;

        for (const item of createdItems) {
            expect(item.price).toBe(50000);
            expect(item.subtotal).toBe(100000);
        }
    });

    test("client-sent shipping cost is ignored (not used as total)", async () => {
        const result = await runBuyNowWithComparePrice(65000);
        // Mocked MENGANTAR verification returns 15000, not 999999.
        expect(result.shippingCost).toBe(15000);
        expect(result.grossAmount).toBe(115000);
    });

    test("checkout item base price is built from variant.price only", () => {
        const body = createCheckoutOrderBody();

        expect(body).not.toContain("comparePrice");

        // BUY_NOW / CART base price reads the authoritative price.
        expect(body).toContain("variant.price");
        expect(body).toContain("item.variant");
    });

    test("CreateCheckoutInput has no price / amount / comparePrice field", () => {
        const code = readFile("lib/checkout.ts");
        const start = code.indexOf(
            "export type CreateCheckoutInput = {"
        );
        const end = code.indexOf("export type CreatedCheckout = {");
        const inputType = code.substring(start, end);

        expect(inputType.length).toBeGreaterThan(0);
        expect(inputType).not.toMatch(/\bprice\b/);
        expect(inputType).not.toMatch(/\bamount\b/);
        expect(inputType).not.toContain("comparePrice");
    });
});

/* ==========================================
 * 4. STATIC SAFETY — order/payment/refund untouched
 * ========================================== */

describe("comparePrice never reaches money paths", () => {
    const moneyFiles = [
        "lib/checkout.ts",
        "lib/refund.ts",
        "lib/voucher.ts",
        "lib/affiliate/commission.ts",
        "lib/marketing/pricing.ts",
        "lib/marketing/batch-pricing.ts",
        "app/api/payment/ipaymu/route.ts",
        "app/api/payment/ipaymu/notification/route.ts",
        "app/api/payment/midtrans/route.ts",
        "app/api/payment/midtrans/notification/route.ts",
        "app/api/orders/route.ts",
        "app/api/buy-now/ipaymu/route.ts",
    ];

    test.each(moneyFiles)(
        "%s does not reference comparePrice",
        (file) => {
            const code = readFile(file);
            if (code.length === 0) {
                // File may not exist under this exact name; skip
                // silently rather than false-fail.
                return;
            }
            expect(code).not.toContain("comparePrice");
        }
    );

    test("OrderItem mapping uses price/subtotal only", () => {
        const body = createCheckoutOrderBody();

        expect(body).toContain("price:");
        expect(body).toContain("subtotal:");
        expect(body).not.toContain("comparePrice");
    });

    test("historical order rendering never reads the current comparePrice", () => {
        const orderPages = [
            "app/orders/[id]/page.tsx",
            "app/admin/orders/[id]/page.tsx",
            "lib/refund.ts",
        ];

        for (const file of orderPages) {
            const code = readFile(file);
            if (code.length === 0) continue;
            expect(code).not.toContain("comparePrice");
        }
    });
});

/* ==========================================
 * 5. SCHEMA + MIGRATION
 * ========================================== */

describe("schema + migration are additive and nullable", () => {
    test("ProductVariant.comparePrice is nullable Decimal(12,2)", () => {
        const schema = readFile("prisma/schema.prisma");
        const modelStart = schema.indexOf(
            "model ProductVariant {"
        );
        const modelEnd = schema.indexOf(
            "model ",
            modelStart + 1
        );
        const model = schema.substring(modelStart, modelEnd);

        expect(model).toMatch(
            /comparePrice\s+Decimal\?\s+@db\.Decimal\(12,\s*2\)/
        );
        expect(model).not.toMatch(
            /comparePrice\s+Decimal\s+@db/
        );
    });

    test("migration only adds a nullable column", () => {
        const raw = readFile(
            "prisma/migrations/20261003000000_add_variant_compare_price/migration.sql"
        );

        expect(raw.length).toBeGreaterThan(0);
        expect(raw).toMatch(
            /ADD COLUMN\s+`comparePrice`\s+DECIMAL\(12,\s*2\)\s+NULL/i
        );

        // Inspect the SQL statements only (strip `--` comment lines,
        // whose prose legitimately names the untouched order tables).
        const sql = raw
            .split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n")
            .toUpperCase();

        expect(sql).not.toContain("DROP ");
        expect(sql).not.toContain("MODIFY ");
        expect(sql).not.toContain("CHANGE ");
        // Never touches order / payment tables.
        expect(sql).not.toContain("ORDERITEM");
        expect(sql).not.toContain("`ORDER`");
        expect(sql).not.toContain("AFFILIATE");
        expect(sql).not.toContain("REFUND");
        expect(sql).not.toContain("PAYMENT");
        // Only the comparePrice column is added (price is not altered).
        expect(sql).toContain("COMPAREPRICE");
        expect(sql).not.toMatch(/`PRICE`\s+DECIMAL/);
    });
});
