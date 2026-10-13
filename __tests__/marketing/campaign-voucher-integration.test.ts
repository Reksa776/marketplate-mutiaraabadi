/**
 * ==========================================
 * M2: CAMPAIGN ↔ VOUCHER INTEGRATION TESTS
 * ==========================================
 *
 * Regression tests for M2 bug fixes:
 * - M2-BUG-1: Campaign-specific vouchers work at checkout
 * - M2-BUG-2: Voucher PATCH validates campaignId
 * - M2-BUG-3: Voucher DELETE checks campaign assignment
 *
 * Run: npx jest __tests__/marketing/campaign-voucher-integration.test.ts
 */

// ==========================================
// MOCK PRISMA
// ==========================================

const mockPrisma = {
    flashSale: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
    },
    productDiscount: {
        findMany: jest.fn().mockResolvedValue([]),
    },
    bulkDiscount: {
        findMany: jest.fn().mockResolvedValue([]),
    },
    campaign: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
    },
    shippingDiscount: {
        findFirst: jest.fn().mockResolvedValue(null),
    },
    voucher: {
        findUnique: jest.fn().mockResolvedValue(null),
    },
    voucherUserUsage: {
        findUnique: jest.fn().mockResolvedValue(null),
    },
    order: {
        count: jest.fn().mockResolvedValue(0),
    },
    product: {
        findMany: jest.fn().mockResolvedValue([]),
    },
};

jest.mock("@/lib/prisma", () => ({
    prisma: mockPrisma,
}));

// ==========================================
// IMPORTS (after mock setup)
// ==========================================

import {
    resolveBatchPrices,
    resolveOrderCampaignId,
} from "@/lib/marketing/batch-pricing";
import {
    validateAndCalculateVoucherEnhanced,
    incrementVoucherUsage,
    incrementVoucherUserUsage,
} from "@/lib/voucher";
import {
    calculateCampaignStatus,
    isCampaignActive,
} from "@/lib/marketing/campaign";

// ==========================================
// HELPERS
// ==========================================

function decimal(value: number) {
    return { toString: () => String(value), valueOf: () => value } as any;
}

function makeCampaign(overrides: Partial<any> = {}) {
    return {
        id: 1,
        name: "Test Campaign",
        slug: "test-campaign",
        type: "GENERAL",
        status: "ACTIVE",
        startAt: new Date("2020-01-01"),
        endAt: new Date("2099-12-31"),
        discountType: "PERCENTAGE",
        discountValue: decimal(10),
        maxDiscount: decimal(50000),
        priority: 0,
        products: [],
        categories: [],
        ...overrides,
    };
}

// ==========================================
// A. BATCH PRICING: campaignId PROPAGATION
// ==========================================

describe("A. Batch Pricing: campaignId propagation", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("BatchPricingResult includes campaignId field (defaults to null)", async () => {
        mockPrisma.flashSale.findMany.mockResolvedValue([]);
        mockPrisma.productDiscount.findMany.mockResolvedValue([]);
        mockPrisma.campaign.findMany.mockResolvedValue([]);
        mockPrisma.bulkDiscount.findMany.mockResolvedValue([]);

        const results = await resolveBatchPrices([
            { productId: 1, variantId: 1, originalPrice: 100000, quantity: 1 },
        ]);

        expect(results[0]).toHaveProperty("campaignId");
        expect(results[0].campaignId).toBeNull();
    });

    test("Campaign source sets campaignId on pricing result", async () => {
        mockPrisma.flashSale.findMany.mockResolvedValue([]);
        mockPrisma.productDiscount.findMany.mockResolvedValue([]);

        const campaign = makeCampaign({ id: 42 });
        mockPrisma.campaign.findMany.mockResolvedValue([campaign]);
        mockPrisma.bulkDiscount.findMany.mockResolvedValue([]);

        const results = await resolveBatchPrices([
            { productId: 1, variantId: 1, originalPrice: 100000, quantity: 1 },
        ]);

        expect(results[0].source).toBe("CAMPAIGN");
        expect(results[0].campaignId).toBe(42);
    });

    test("Flash Sale source has campaignId=null", async () => {
        mockPrisma.flashSale.findMany.mockResolvedValue([
            {
                variantId: 1,
                salePrice: decimal(75000),
                id: 10,
                name: "Flash",
                endAt: new Date("2099-01-01"),
            },
        ]);
        mockPrisma.productDiscount.findMany.mockResolvedValue([]);
        mockPrisma.campaign.findMany.mockResolvedValue([makeCampaign({ id: 5 })]);
        mockPrisma.bulkDiscount.findMany.mockResolvedValue([]);

        const results = await resolveBatchPrices([
            { productId: 1, variantId: 1, originalPrice: 100000, quantity: 1 },
        ]);

        expect(results[0].source).toBe("FLASH_SALE");
        expect(results[0].campaignId).toBeNull();
    });
});

// ==========================================
// B. resolveOrderCampaignId
// ==========================================

describe("B. resolveOrderCampaignId", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("Returns null when no active campaigns", async () => {
        mockPrisma.campaign.findMany.mockResolvedValue([]);

        const result = await resolveOrderCampaignId([
            { productId: 1, category: "Electronics" },
        ]);

        expect(result).toBeNull();
    });

    test("Returns GENERAL campaign ID for any product", async () => {
        mockPrisma.campaign.findMany.mockResolvedValue([
            makeCampaign({ id: 10, type: "GENERAL" }),
        ]);

        const result = await resolveOrderCampaignId([
            { productId: 1, category: "Electronics" },
        ]);

        expect(result).toBe(10);
    });

    test("Returns PRODUCT_DISCOUNT campaign when product matches", async () => {
        mockPrisma.campaign.findMany.mockResolvedValue([
            makeCampaign({
                id: 20,
                type: "PRODUCT_DISCOUNT",
                products: [{ productId: 1 }],
            }),
        ]);

        const result = await resolveOrderCampaignId([
            { productId: 1, category: "Electronics" },
        ]);

        expect(result).toBe(20);
    });

    test("Returns CATEGORY_DISCOUNT campaign when category matches", async () => {
        mockPrisma.campaign.findMany.mockResolvedValue([
            makeCampaign({
                id: 30,
                type: "CATEGORY_DISCOUNT",
                categories: [{ category: "electronics" }],
            }),
        ]);

        const result = await resolveOrderCampaignId([
            { productId: 1, category: "Electronics" },
        ]);

        expect(result).toBe(30);
    });

    test("Returns null when campaign has no discount config", async () => {
        mockPrisma.campaign.findMany.mockResolvedValue([
            makeCampaign({ discountType: null, discountValue: null }),
        ]);

        const result = await resolveOrderCampaignId([
            { productId: 1, category: "Electronics" },
        ]);

        expect(result).toBeNull();
    });

    test("Returns first (highest priority) matching campaign", async () => {
        mockPrisma.campaign.findMany.mockResolvedValue([
            makeCampaign({ id: 1, priority: 10, type: "GENERAL" }),
            makeCampaign({ id: 2, priority: 5, type: "GENERAL" }),
        ]);

        const result = await resolveOrderCampaignId([
            { productId: 1, category: "Electronics" },
        ]);

        expect(result).toBe(1);
    });
});

// ==========================================
// C. VOUCHER ↔ CAMPAIGN VALIDATION
// ==========================================

describe("C. Voucher ↔ Campaign validation", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("Campaign-specific voucher FAILS when campaignId is null", async () => {
        const now = new Date();
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 1,
            code: "CAMPAIGN10",
            type: "PERCENTAGE",
            value: decimal(10),
            maxDiscount: decimal(50000),
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: 99,
            maxUsagePerUser: null,
            eligibility: "ALL",
            productRestrictions: [],
            categoryRestrictions: [],
        });

        // Campaign exists and is active
        mockPrisma.campaign.findUnique.mockResolvedValue(
            makeCampaign({ id: 99 })
        );

        const result = await validateAndCalculateVoucherEnhanced(
            "CAMPAIGN10",
            100000,
            [{ productId: 1, variantId: 1, quantity: 1, price: 100000 }],
            "user-1",
            null, // <-- campaignId is null (old broken behavior)
            mockPrisma as any
        );

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.message).toContain("kampanye");
        }
    });

    test("Campaign-specific voucher SUCCEEDS when correct campaignId is passed", async () => {
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 1,
            code: "CAMPAIGN10",
            type: "PERCENTAGE",
            value: decimal(10),
            maxDiscount: decimal(50000),
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: 99,
            maxUsagePerUser: null,
            eligibility: "ALL",
            productRestrictions: [],
            categoryRestrictions: [],
        });

        mockPrisma.campaign.findUnique.mockResolvedValue(
            makeCampaign({ id: 99 })
        );

        const result = await validateAndCalculateVoucherEnhanced(
            "CAMPAIGN10",
            100000,
            [{ productId: 1, variantId: 1, quantity: 1, price: 100000 }],
            "user-1",
            99, // <-- correct campaignId
            mockPrisma as any
        );

        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.discount).toBe(10000); // 10% of 100000
        }
    });

    test("Campaign-specific voucher FAILS when wrong campaignId is passed", async () => {
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 1,
            code: "CAMPAIGN10",
            type: "PERCENTAGE",
            value: decimal(10),
            maxDiscount: decimal(50000),
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: 99,
            maxUsagePerUser: null,
            eligibility: "ALL",
            productRestrictions: [],
            categoryRestrictions: [],
        });

        const result = await validateAndCalculateVoucherEnhanced(
            "CAMPAIGN10",
            100000,
            [{ productId: 1, variantId: 1, quantity: 1, price: 100000 }],
            "user-1",
            50, // <-- wrong campaignId
            mockPrisma as any
        );

        expect(result.valid).toBe(false);
    });

    test("Non-campaign voucher still works without campaignId", async () => {
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 2,
            code: "GENERAL10",
            type: "PERCENTAGE",
            value: decimal(10),
            maxDiscount: null,
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: null,
            maxUsagePerUser: null,
            eligibility: "ALL",
            productRestrictions: [],
            categoryRestrictions: [],
        });

        const result = await validateAndCalculateVoucherEnhanced(
            "GENERAL10",
            100000,
            [{ productId: 1, variantId: 1, quantity: 1, price: 100000 }],
            "user-1",
            null,
            mockPrisma as any
        );

        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.discount).toBe(10000);
        }
    });

    test("Campaign-specific voucher FAILS when campaign is not active", async () => {
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 3,
            code: "EXPIRED-CAMPAIGN",
            type: "FIXED",
            value: decimal(50000),
            maxDiscount: null,
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: 88,
            maxUsagePerUser: null,
            eligibility: "ALL",
            productRestrictions: [],
            categoryRestrictions: [],
        });

        // Campaign exists but is CANCELLED
        mockPrisma.campaign.findUnique.mockResolvedValue(
            makeCampaign({ id: 88, status: "CANCELLED" })
        );

        const result = await validateAndCalculateVoucherEnhanced(
            "EXPIRED-CAMPAIGN",
            100000,
            [{ productId: 1, variantId: 1, quantity: 1, price: 100000 }],
            "user-1",
            88,
            mockPrisma as any
        );

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.message).toContain("tidak aktif");
        }
    });
});

// ==========================================
// D. VOUCHER USAGE INCREMENT + ROLLBACK
// ==========================================

describe("D. Voucher usage increment and rollback", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("incrementVoucherUsage uses conditional SQL", async () => {
        const mockTx = {
            $executeRaw: jest.fn().mockResolvedValue(1),
        };

        const result = await incrementVoucherUsage(
            mockTx as any,
            1
        );

        expect(result).toBe(true);
        expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    test("incrementVoucherUsage returns false when quota exhausted", async () => {
        const mockTx = {
            $executeRaw: jest.fn().mockResolvedValue(0),
        };

        const result = await incrementVoucherUsage(
            mockTx as any,
            1
        );

        expect(result).toBe(false);
    });

    test("incrementVoucherUserUsage uses upsert", async () => {
        const mockTx = {
            voucherUserUsage: {
                upsert: jest.fn().mockResolvedValue({}),
            },
        };

        await incrementVoucherUserUsage(
            mockTx as any,
            1,
            "user-1"
        );

        /*
         * The per-identity limit scope moved from `userId` to
         * `ownerKey` so it also holds for guest buyers (a nullable
         * userId would make every guest distinct in a unique index and
         * silently disable maxUsagePerUser). A logged-in caller still
         * resolves to `user:<userId>`, so this path is unchanged.
         */
        expect(mockTx.voucherUserUsage.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    voucherId_ownerKey: {
                        voucherId: 1,
                        ownerKey: "user:user-1",
                    },
                },
                create: expect.objectContaining({
                    voucherId: 1,
                    userId: "user-1",
                    ownerKey: "user:user-1",
                    usageCount: 1,
                }),
                update: expect.objectContaining({
                    usageCount: { increment: 1 },
                }),
            })
        );
    });
});

// ==========================================
// E. CAMPAIGN STATUS COMPUTATION
// ==========================================

describe("E. Campaign status computation", () => {
    test("ACTIVE when within startAt/endAt", () => {
        const campaign = {
            status: "ACTIVE" as const,
            startAt: new Date("2020-01-01"),
            endAt: new Date("2099-12-31"),
        };
        expect(calculateCampaignStatus(campaign)).toBe("ACTIVE");
        expect(isCampaignActive(campaign)).toBe(true);
    });

    test("SCHEDULED when before startAt", () => {
        const campaign = {
            status: "ACTIVE" as const,
            startAt: new Date("2099-01-01"),
            endAt: new Date("2099-12-31"),
        };
        expect(calculateCampaignStatus(campaign)).toBe("SCHEDULED");
        expect(isCampaignActive(campaign)).toBe(false);
    });

    test("ENDED when after endAt", () => {
        const campaign = {
            status: "ACTIVE" as const,
            startAt: new Date("2020-01-01"),
            endAt: new Date("2020-12-31"),
        };
        expect(calculateCampaignStatus(campaign)).toBe("ENDED");
        expect(isCampaignActive(campaign)).toBe(false);
    });

    test("DRAFT never auto-activates", () => {
        const campaign = {
            status: "DRAFT" as const,
            startAt: new Date("2020-01-01"),
            endAt: new Date("2099-12-31"),
        };
        expect(calculateCampaignStatus(campaign)).toBe("DRAFT");
        expect(isCampaignActive(campaign)).toBe(false);
    });

    test("CANCELLED never auto-activates", () => {
        const campaign = {
            status: "CANCELLED" as const,
            startAt: new Date("2020-01-01"),
            endAt: new Date("2099-12-31"),
        };
        expect(calculateCampaignStatus(campaign)).toBe("CANCELLED");
        expect(isCampaignActive(campaign)).toBe(false);
    });

    test("Status transitions are time-based, not DB-stored", () => {
        // Even if DB says ACTIVE, if now > endAt, it's ENDED
        const campaign = {
            status: "ACTIVE" as const,
            startAt: new Date("2020-01-01"),
            endAt: new Date("2025-12-31"),
        };
        // Now is 2026 (from project date)
        const now = new Date("2026-01-01");
        expect(calculateCampaignStatus(campaign, now)).toBe("ENDED");
        expect(isCampaignActive(campaign, now)).toBe(false);
    });
});

// ==========================================
// F. VOUCHER ENHANCED VALIDATION EDGE CASES
// ==========================================

describe("F. Voucher enhanced validation edge cases", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("Per-user limit enforced", async () => {
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 1,
            code: "LIMITED",
            type: "FIXED",
            value: decimal(10000),
            maxDiscount: null,
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: null,
            maxUsagePerUser: 2,
            eligibility: "ALL",
            productRestrictions: [],
            categoryRestrictions: [],
        });
        mockPrisma.voucherUserUsage.findUnique.mockResolvedValue({
            id: 1,
            voucherId: 1,
            userId: "user-1",
            usageCount: 2,
        });

        const result = await validateAndCalculateVoucherEnhanced(
            "LIMITED",
            100000,
            [{ productId: 1, variantId: 1, quantity: 1, price: 100000 }],
            "user-1",
            null,
            mockPrisma as any
        );

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.message).toContain("batas penggunaan");
        }
    });

    test("Product restriction rejects disallowed product", async () => {
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 1,
            code: "PRODONLY",
            type: "FIXED",
            value: decimal(10000),
            maxDiscount: null,
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: null,
            maxUsagePerUser: null,
            eligibility: "ALL",
            productRestrictions: [{ productId: 999 }],
            categoryRestrictions: [],
        });

        const result = await validateAndCalculateVoucherEnhanced(
            "PRODONLY",
            100000,
            [{ productId: 1, variantId: 1, quantity: 1, price: 100000 }],
            "user-1",
            null,
            mockPrisma as any
        );

        expect(result.valid).toBe(false);
    });

    test("Category restriction rejects disallowed category", async () => {
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 1,
            code: "ELECTRONICS",
            type: "FIXED",
            value: decimal(10000),
            maxDiscount: null,
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: null,
            maxUsagePerUser: null,
            eligibility: "ALL",
            productRestrictions: [],
            categoryRestrictions: [{ category: "electronics" }],
        });

        const result = await validateAndCalculateVoucherEnhanced(
            "ELECTRONICS",
            100000,
            [{ productId: 1, variantId: 1, quantity: 1, price: 100000, category: "food" }],
            "user-1",
            null,
            mockPrisma as any
        );

        expect(result.valid).toBe(false);
    });

    test("NEW_USER eligibility enforced", async () => {
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 1,
            code: "NEWUSER",
            type: "FIXED",
            value: decimal(20000),
            maxDiscount: null,
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: null,
            maxUsagePerUser: null,
            eligibility: "NEW_USER",
            productRestrictions: [],
            categoryRestrictions: [],
        });
        mockPrisma.order.count.mockResolvedValue(5);

        const result = await validateAndCalculateVoucherEnhanced(
            "NEWUSER",
            100000,
            [{ productId: 1, variantId: 1, quantity: 1, price: 100000 }],
            "user-1",
            null,
            mockPrisma as any
        );

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.message).toContain("pengguna baru");
        }
    });

    test("Quota exceeded rejected", async () => {
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 1,
            code: "FULL",
            type: "FIXED",
            value: decimal(10000),
            maxDiscount: null,
            minPurchase: null,
            quota: 10,
            usedCount: 10,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: null,
            maxUsagePerUser: null,
            eligibility: "ALL",
            productRestrictions: [],
            categoryRestrictions: [],
        });

        const result = await validateAndCalculateVoucherEnhanced(
            "FULL",
            100000,
            [],
            "user-1",
            null,
            mockPrisma as any
        );

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.message).toContain("habis");
        }
    });

    test("Voucher capped at subtotal (no negative discount)", async () => {
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 1,
            code: "BIG",
            type: "FIXED",
            value: decimal(500000),
            maxDiscount: null,
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: null,
            maxUsagePerUser: null,
            eligibility: "ALL",
            productRestrictions: [],
            categoryRestrictions: [],
        });

        const result = await validateAndCalculateVoucherEnhanced(
            "BIG",
            100000,
            [],
            "user-1",
            null,
            mockPrisma as any
        );

        expect(result.valid).toBe(true);
        if (result.valid) {
            // Discount capped at subtotal, not 500000
            expect(result.discount).toBe(100000);
        }
    });

    test("Percentage voucher with maxDiscount cap", async () => {
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 1,
            code: "PCTCAP",
            type: "PERCENTAGE",
            value: decimal(20),
            maxDiscount: decimal(50000),
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: null,
            maxUsagePerUser: null,
            eligibility: "ALL",
            productRestrictions: [],
            categoryRestrictions: [],
        });

        // 20% of 500000 = 100000, but capped at 50000
        const result = await validateAndCalculateVoucherEnhanced(
            "PCTCAP",
            500000,
            [],
            "user-1",
            null,
            mockPrisma as any
        );

        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.discount).toBe(50000);
        }
    });
});

// ==========================================
// G. VOUCHER STACKING WITH CAMPAIGN PRICING
// ==========================================

describe("G. Voucher stacking with campaign pricing", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("Voucher discount is applied on top of campaign-discounted subtotal", async () => {
        // Campaign gives 10% off, then voucher gives additional 10% off
        // Original: 100000
        // Campaign: 100000 * 0.9 = 90000
        // Voucher: 90000 * 0.1 = 9000
        // Final: 90000 - 9000 = 81000

        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 1,
            code: "EXTRA10",
            type: "PERCENTAGE",
            value: decimal(10),
            maxDiscount: null,
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: null,
            maxUsagePerUser: null,
            eligibility: "ALL",
            productRestrictions: [],
            categoryRestrictions: [],
        });

        // Subtotal is already campaign-discounted (90000)
        const campaignDiscountedSubtotal = 90000;

        const result = await validateAndCalculateVoucherEnhanced(
            "EXTRA10",
            campaignDiscountedSubtotal,
            [],
            "user-1",
            null,
            mockPrisma as any
        );

        expect(result.valid).toBe(true);
        if (result.valid) {
            // 10% of 90000 = 9000
            expect(result.discount).toBe(9000);
        }
    });

    test("Non-campaign voucher works during campaign pricing (stacking allowed)", async () => {
        // This tests the key integration: campaign pricing + voucher discount can stack

        // Step 1: batch pricing gives campaign discount
        const campaign = makeCampaign({ id: 10 });
        mockPrisma.flashSale.findMany.mockResolvedValue([]);
        mockPrisma.productDiscount.findMany.mockResolvedValue([]);
        mockPrisma.campaign.findMany.mockResolvedValue([campaign]);
        mockPrisma.bulkDiscount.findMany.mockResolvedValue([]);

        const pricing = await resolveBatchPrices([
            { productId: 1, variantId: 1, originalPrice: 100000, quantity: 1 },
        ]);

        expect(pricing[0].source).toBe("CAMPAIGN");
        expect(pricing[0].effectivePrice).toBe(90000); // 10% off

        // Step 2: voucher validation on campaign-discounted price
        mockPrisma.voucher.findUnique.mockResolvedValue({
            id: 2,
            code: "EXTRA20",
            type: "FIXED",
            value: decimal(15000),
            maxDiscount: null,
            minPurchase: null,
            quota: null,
            usedCount: 0,
            isActive: true,
            startDate: null,
            endDate: null,
            campaignId: null,
            maxUsagePerUser: null,
            eligibility: "ALL",
            productRestrictions: [],
            categoryRestrictions: [],
        });

        const voucherResult = await validateAndCalculateVoucherEnhanced(
            "EXTRA20",
            pricing[0].effectivePrice,
            [],
            "user-1",
            null,
            mockPrisma as any
        );

        expect(voucherResult.valid).toBe(true);
        if (voucherResult.valid) {
            expect(voucherResult.discount).toBe(15000);
        }
    });
});

// ==========================================
// H. CHECKOUT INTEGRATION: resolveOrderCampaignId IN TRANSACTION
// ==========================================

describe("H. Checkout integration: campaign context resolution", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("resolveOrderCampaignId called with correct items for CART checkout", async () => {
        // Simulates what createCheckoutOrder does after resolveBatchMarketingPricing
        const campaign = makeCampaign({ id: 77, type: "GENERAL" });
        mockPrisma.campaign.findMany.mockResolvedValue([campaign]);

        const cartItems = [
            { productId: 1, category: "Electronics" },
            { productId: 2, category: "Clothing" },
        ];

        const campaignId = await resolveOrderCampaignId(cartItems);

        expect(campaignId).toBe(77);
    });

    test("resolveOrderCampaignId returns null when no campaigns match any item", async () => {
        mockPrisma.campaign.findMany.mockResolvedValue([
            makeCampaign({
                id: 50,
                type: "PRODUCT_DISCOUNT",
                products: [{ productId: 999 }],
            }),
        ]);

        const campaignId = await resolveOrderCampaignId([
            { productId: 1, category: "Electronics" },
        ]);

        expect(campaignId).toBeNull();
    });

    test("resolveOrderCampaignId handles empty items", async () => {
        mockPrisma.campaign.findMany.mockResolvedValue([
            makeCampaign({ id: 10, type: "GENERAL" }),
        ]);

        const campaignId = await resolveOrderCampaignId([]);

        expect(campaignId).toBeNull();
    });
});

// ==========================================
// I. M3: CONCURRENCY FIXES (P2-1, P3-1)
// ==========================================

describe("I. M3 Concurrency Fixes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("incrementVoucherUserUsage returns new usage count", async () => {
        const mockTx = {
            voucherUserUsage: {
                upsert: jest.fn().mockResolvedValue({
                    usageCount: 2,
                }),
            },
        };

        const result = await incrementVoucherUserUsage(
            mockTx as any,
            1,
            "user-1"
        );

        expect(result).toBe(2);
    });

    test("incrementVoucherUserUsage returns 1 on first use", async () => {
        const mockTx = {
            voucherUserUsage: {
                upsert: jest.fn().mockResolvedValue({
                    usageCount: 1,
                }),
            },
        };

        const result = await incrementVoucherUserUsage(
            mockTx as any,
            1,
            "user-1"
        );

        expect(result).toBe(1);
    });

    test("incrementVoucherUsage still uses atomic conditional SQL", async () => {
        const mockTx = {
            $executeRaw: jest.fn().mockResolvedValue(1),
        };

        const result = await incrementVoucherUsage(
            mockTx as any,
            1
        );

        expect(result).toBe(true);
    });

    test("incrementVoucherUsage returns false when quota exhausted", async () => {
        const mockTx = {
            $executeRaw: jest.fn().mockResolvedValue(0),
        };

        const result = await incrementVoucherUsage(
            mockTx as any,
            1
        );

        expect(result).toBe(false);
    });
});
