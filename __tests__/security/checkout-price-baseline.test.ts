/**
 * ==========================================
 * CHECKOUT PRICE BASELINE — SERVER AUTHORITATIVE
 * ==========================================
 *
 * Business rule under guard:
 *
 *   ProductVariant.price ("Harga Normal")
 *        ↓
 *   Marketing override (if active)
 *        ↓
 *   Final unit price  →  subtotal  →  OrderItem.price  →  Order.total
 *        ↓
 *   COD nominal / iPaymu amount / Midtrans gross_amount
 *
 * The browser NEVER supplies an authoritative price. `CreateCheckoutInput`
 * carries only productId/variantId/quantity (+ selections), and every
 * price is re-resolved from the DB on the server.
 *
 * Exercises the REAL `createCheckoutOrder` with a mocked Prisma layer.
 * No real order, payment, shipment or DB write happens.
 *
 * Run: npx jest __tests__/security/checkout-price-baseline.test.ts
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
        findMany: jest.fn(),
        update: jest.fn(),
    },
    cart: {
        findUnique: jest.fn(),
    },
    order: {
        create: jest.fn(),
    },
    // COD + Mengantar checkout enqueues the shipment outbox inside the
    // same transaction (lib/checkout.ts).
    shipmentJob: {
        createMany: jest.fn(),
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
    voucher: {
        findUnique: jest.fn(),
    },
    $executeRaw: jest.fn(),
};

const mockPrisma = {
    userAddress: { findFirst: jest.fn() },
    storeSetting: { findUnique: jest.fn() },
    productVariant: { findUnique: jest.fn() },
    cartItem: { findMany: jest.fn() },
    $transaction: jest.fn(),
};

jest.mock("@/lib/prisma", () => ({
    prisma: mockPrisma,
}));

jest.mock("@/lib/marketing/flash-sale", () => ({
    recordFlashSalePurchase: jest.fn(),
    hasReachedFlashSaleLimit: jest.fn(),
}));

const mockValidateVoucher = jest.fn();
jest.mock("@/lib/voucher", () => ({
    incrementVoucherUsage: jest.fn(async () => true),
    incrementVoucherUserUsage: jest.fn(async () => 1),
    validateAndCalculateVoucherEnhanced: (...args: unknown[]) =>
        mockValidateVoucher(...args),
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

import { createCheckoutOrder } from "@/lib/checkout";

/* ==========================================
 * HELPERS
 * ========================================== */

const SHIPPING = 15000;

function readFile(relativePath: string): string {
    try {
        return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
    } catch {
        return "";
    }
}

/** Marketing stub: passthrough (no override). */
function noMarketing() {
    mockResolveBatchPrices.mockImplementation(
        async (
            items: Array<{ originalPrice: number; quantity: number }>
        ) =>
            items.map((item) => ({
                effectivePrice: item.originalPrice,
                originalPrice: item.originalPrice,
                discountAmount: 0,
                source: "ORIGINAL",
                flashSaleId: null,
            }))
    );
}

/** Marketing stub: -10% on every item (applied to `originalPrice`). */
function tenPercentOff() {
    mockResolveBatchPrices.mockImplementation(
        async (
            items: Array<{ originalPrice: number; quantity: number }>
        ) =>
            items.map((item) => {
                const off = Math.round(item.originalPrice * 0.1);
                return {
                    effectivePrice: item.originalPrice - off,
                    originalPrice: item.originalPrice,
                    discountAmount: off,
                    source: "PRODUCT_DISCOUNT",
                    flashSaleId: null,
                };
            })
    );
}

function buyNowVariant(price: number) {
    return {
        id: 7,
        productId: 3,
        name: "Merah",
        price,
        comparePrice: null,
        stock: 10,
        product: { id: 3, name: "Kaos" },
    };
}

/** Last order.create payload captured from checkout. */
function lastOrderCreateData(): any {
    const calls = mockTx.order.create.mock.calls;
    return calls[calls.length - 1][0].data;
}

function createdItems(): Array<{ price: number; subtotal: number }> {
    return lastOrderCreateData().items.create;
}

beforeEach(() => {
    jest.clearAllMocks();

    mockResolveBatchPrices.mockReset();
    mockResolveOrderCampaignId.mockReset();
    mockValidateVoucher.mockReset();

    mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
        if (typeof arg === "function") {
            return (arg as (tx: unknown) => unknown)(mockTx);
        }
        return Promise.all(arg as Promise<unknown>[]);
    });

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

    mockPrisma.productVariant.findUnique.mockResolvedValue({ weight: 1000 });
    mockPrisma.cartItem.findMany.mockResolvedValue([
        { quantity: 2, variant: { weight: 1000 } },
    ]);

    mockTx.product.findMany.mockResolvedValue([
        { id: 3, category: "Kaos" },
    ]);

    mockTx.order.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
            id: 42,
            ...data,
        })
    );
    mockTx.productVariant.updateMany.mockResolvedValue({ count: 1 });
    mockTx.product.update.mockResolvedValue({});
    mockTx.cartItem.deleteMany.mockResolvedValue({ count: 1 });

    mockResolveOrderCampaignId.mockResolvedValue(null);
});

function runBuyNow(
    price: number,
    quantity = 2,
    extra: Record<string, unknown> = {}
) {
    mockTx.productVariant.findFirst.mockResolvedValue(buyNowVariant(price));

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
        quantity,
        ...extra,
    } as any);
}

function runCart(
    price: number,
    quantity = 2,
    extra: Record<string, unknown> = {}
) {
    mockTx.cart.findUnique.mockResolvedValue({
        id: 1,
        items: [
            {
                id: 11,
                quantity,
                productId: 3,
                variantId: 7,
                product: { id: 3, name: "Kaos", category: "Kaos" },
                variant: {
                    id: 7,
                    name: "Merah",
                    price,
                    comparePrice: null,
                    stock: 10,
                    weight: 1000,
                },
            },
        ],
    });

    return createCheckoutOrder({
        userId: "user-1",
        mode: "CART",
        addressId: "addr-1",
        shipping: {
            provider: "MENGANTAR",
            courier: "JNE",
            service: "REG",
            cost: 999999,
        },
        paymentMethod: "COD",
        ...extra,
    } as any);
}

/* ==========================================
 * CASE 1 — Harga Normal is the checkout baseline
 * ========================================== */

describe("CASE 1 — checkout uses the Harga Normal when no marketing", () => {
    test("BUY_NOW: unit price = 20.000, subtotal = 40.000, total includes shipping", async () => {
        noMarketing();

        const result = await runBuyNow(20000, 2);

        expect(result.subtotal).toBe(40000);
        expect(result.shippingCost).toBe(SHIPPING);
        expect(result.grossAmount).toBe(40000 + SHIPPING);

        for (const item of createdItems()) {
            expect(item.price).toBe(20000);
            expect(item.subtotal).toBe(40000);
        }

        expect(lastOrderCreateData().total).toBe(40000 + SHIPPING);
        expect(lastOrderCreateData().subtotal).toBe(40000);
    });
});

/* ==========================================
 * CASE 4 — browser cannot manipulate the price
 * ========================================== */

describe("CASE 4 — browser-supplied price is ignored", () => {
    test("bogus price/subtotal/total fields do not affect the order", async () => {
        noMarketing();

        const result = await runBuyNow(20000, 2, {
            price: 1000,
            unitPrice: 1000,
            subtotal: 1000,
            total: 1000,
        });

        expect(result.subtotal).toBe(40000);
        expect(result.grossAmount).toBe(40000 + SHIPPING);

        for (const item of createdItems()) {
            expect(item.price).toBe(20000);
            expect(item.subtotal).toBe(40000);
        }
    });

    test("CreateCheckoutInput declares no price-bearing field", () => {
        const code = readFile("lib/checkout.ts");
        const start = code.indexOf("export type CreateCheckoutInput = {");
        const end = code.indexOf("export type CreatedCheckout = {");
        const inputType = code.substring(start, end);

        expect(inputType.length).toBeGreaterThan(0);
        expect(inputType).not.toMatch(/\bprice\b/);
        expect(inputType).not.toMatch(/\bunitPrice\b/);
        expect(inputType).not.toMatch(/\bsubtotal\b/);
        expect(inputType).not.toMatch(/\btotal\b/);
        expect(inputType).not.toContain("comparePrice");
    });
});

/* ==========================================
 * CASE 5 — stale cart price is recomputed
 * ========================================== */

describe("CASE 5 — stale/cart display price cannot set the baseline", () => {
    test("CART checkout re-resolves the authoritative variant price", async () => {
        noMarketing();

        const result = await runCart(20000, 2, {
            // stale values a browser might still be echoing
            price: 17500,
            subtotal: 35000,
        });

        expect(result.subtotal).toBe(40000);
        for (const item of createdItems()) {
            expect(item.price).toBe(20000);
            expect(item.subtotal).toBe(40000);
        }
    });

    test("CART item price is read from item.variant.price on the server", () => {
        const code = readFile("lib/checkout.ts");
        // The CART branch reads `item.variant.price` (authoritative),
        // regardless of whitespace / line endings.
        expect(code).toMatch(/item\.variant[\s\S]{0,40}\.price/);
    });
});

/* ==========================================
 * CASE 6 — Buy Now equals normal checkout
 * ========================================== */

describe("CASE 6 — Buy Now and cart checkout share one pricing rule", () => {
    test("same Harga Normal + marketing → identical unit price in both modes", async () => {
        tenPercentOff();

        const buyNow = await runBuyNow(20000, 2);
        const fromCart = await runCart(20000, 2);

        expect(buyNow.subtotal).toBe(36000); // 18.000 × 2
        expect(fromCart.subtotal).toBe(36000);
        expect(buyNow.grossAmount).toBe(fromCart.grossAmount);

        for (const item of [
            ...(buyNow.order as any).items.create,
        ]) {
            expect(item.price).toBe(18000);
        }
        expect(createdItems()[0].price).toBe(18000);
    });
});

/* ==========================================
 * CASE 7 — voucher ordering is preserved
 * ========================================== */

describe("CASE 7 — voucher applies to the marketing-adjusted subtotal", () => {
    test("marketing first, then voucher on the reduced subtotal", async () => {
        tenPercentOff();
        mockTx.voucher.findUnique.mockResolvedValue({
            maxUsagePerUser: null,
        });
        mockValidateVoucher.mockResolvedValue({
            valid: true,
            discount: 2000,
            voucher: { id: 5, code: "HEMAT" },
        });

        const result = await runBuyNow(20000, 2, { voucherCode: "HEMAT" });

        // subtotal = 18.000 × 2 = 36.000 → voucher 2.000.
        expect(result.subtotal).toBe(36000);
        expect(result.discount).toBe(2000);
        expect(result.grossAmount).toBe(36000 - 2000 + SHIPPING);

        // Voucher must receive the marketing-adjusted item prices.
        const voucherItems = mockValidateVoucher.mock.calls[0][2] as Array<{
            price: number;
        }>;
        expect(voucherItems[0].price).toBe(18000);
    });
});

/* ==========================================
 * CASE 8 — COD nominal is the authoritative total
 * ========================================== */

describe("CASE 8 — COD amount equals the authoritative order total", () => {
    test("codAmount = goods + shipping, never a client value", async () => {
        noMarketing();

        const result = await runBuyNow(20000, 2);
        const data = lastOrderCreateData();

        expect(data.codAmount).toBe(result.grossAmount);
        expect(data.codAmount).toBe(40000 + SHIPPING);
        expect(data.total).toBe(result.grossAmount);
    });
});

/* ==========================================
 * CASE 9 / 10 / 11 — payment + historical immutability
 * ========================================== */

describe("CASE 9 — iPaymu amount derives from the server gross amount", () => {
    test("ipaymu route sends result.grossAmount (not a client price)", () => {
        const route = readFile("app/api/payment/ipaymu/route.ts");
        expect(route).toContain("result.grossAmount");
        expect(route).not.toContain("comparePrice");
        expect(route).not.toMatch(/body\.price/);
    });

    test("ipaymu notification verifies against the stored order total", () => {
        const notification = readFile(
            "app/api/payment/ipaymu/notification/route.ts"
        );
        expect(notification).toContain("existingOrder.total");
        expect(notification).not.toContain("comparePrice");
    });
});

describe("CASE 10 — Midtrans gross_amount derives from the stored order total", () => {
    test("midtrans notification verifies gross_amount against order.total", () => {
        const notification = readFile(
            "app/api/payment/midtrans/notification/route.ts"
        );
        expect(notification).toContain("gross_amount");
        expect(notification).toContain("existingOrder.total");
        expect(notification).not.toContain("comparePrice");
    });
});

describe("CASE 11 — historical OrderItem prices stay immutable", () => {
    test("checkout never updates existing OrderItem prices", () => {
        const code = readFile("lib/checkout.ts");
        // No orderItem update/updateMany anywhere in the checkout module.
        expect(code).not.toMatch(/orderItem\.(update|updateMany)/);
        // The only OrderItem write is the create inside order.create.
        expect(code).toContain("items:");
        expect(code).toContain("price:");
    });

    test("refund and repayment read the stored order total", () => {
        const refund = readFile("lib/refund.ts");
        expect(refund).toContain("order.total");

        const repay = readFile("lib/repay.ts");
        expect(repay).toContain("order.total");
    });

    test("order/product pages render historical snapshots, not current comparePrice", () => {
        for (const file of [
            "app/orders/[id]/page.tsx",
            "app/admin/orders/[id]/page.tsx",
        ]) {
            const code = readFile(file);
            if (code.length === 0) continue;
            expect(code).not.toContain("comparePrice");
        }
    });
});
