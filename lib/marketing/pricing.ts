import { prisma } from "@/lib/prisma";
import { Voucher_type } from "@prisma/client";
import { getActiveFlashSaleForVariant } from "./flash-sale";
import { getActiveProductDiscount, calculateDiscountedPrice } from "./discount";
import { resolveCampaignForProduct, isCampaignActive } from "./campaign";

/**
 * ==========================================
 * UNIFIED PRICING ENGINE
 * ==========================================
 *
 * The most important service in the marketing system.
 *
 * Pricing priority (highest to lowest):
 * 1. FLASH SALE
 * 2. PROMO_LANDING — configured price for one variant
 * 3. PRODUCT DISCOUNT
 * 4. CAMPAIGN DISCOUNT
 * 5. ORIGINAL PRICE
 *
 * IMPORTANT RULES:
 * - Flash Sale has highest priority
 * - If a product/variant is in Flash Sale,
 *   ProductDiscount must NOT additionally reduce the Flash Sale price
 * - Campaign rules evaluated according to stacking specification
 * - Never trust price values supplied by frontend
 * - All financial values use Decimal-safe calculations
 *
 * The pricing engine returns enough information for
 * future checkout integration.
 */

// ==========================================
// TYPES
// ==========================================

export type PriceSource =
    | "ORIGINAL"
    | "PROMO_LANDING"
    | "PRODUCT_DISCOUNT"
    | "CAMPAIGN_DISCOUNT"
    | "FLASH_SALE";

export type ItemPricingResult = {
    productId: number;
    variantId: number;
    originalPrice: number;
    finalPrice: number;
    discountAmount: number;
    discountType: Voucher_type | null;
    source: PriceSource;
    campaignId: number | null;
    productDiscountId: number | null;
    flashSaleId: number | null;
    quantity: number;
    itemSubtotal: number;
};

export type OrderPricingResult = {
    items: ItemPricingResult[];
    originalSubtotal: number;
    finalSubtotal: number;
    totalDiscount: number;
};

// ==========================================
// SINGLE ITEM PRICING
// ==========================================

/**
 * Resolve the price for a single product/variant.
 *
 * Priority:
 * 1. FLASH SALE (if active)
 * 2. PRODUCT DISCOUNT (if active)
 * 3. CAMPAIGN DISCOUNT (if campaign targets this product)
 * 4. ORIGINAL PRICE (ProductVariant.price)
 *
 * @param variantId - Product variant ID
 * @param productId - Product ID
 * @param productCategory - Product category (string)
 * @param now - Current time (for testing)
 * @returns ItemPricingResult with full pricing breakdown
 */
export async function resolveProductPrice(
    variantId: number,
    productId: number,
    productCategory: string | null,
    now: Date = new Date()
): Promise<ItemPricingResult> {
    // Fetch the variant to get the original price
    const variant = await prisma.productVariant.findUnique({
        where: { id: variantId },
    });

    if (!variant) {
        throw new Error(`Variant ${variantId} tidak ditemukan.`);
    }

    const originalPrice = Number(variant.price);

    // ==========================================
    // 1. FLASH SALE (highest priority)
    // ==========================================

    const flashSale = await getActiveFlashSaleForVariant(variantId, now);

    if (flashSale && flashSale.saleStock > 0) {
        const salePrice = Number(flashSale.salePrice);

        return {
            productId,
            variantId,
            originalPrice,
            finalPrice: salePrice,
            discountAmount: originalPrice - salePrice,
            discountType: "FIXED",
            source: "FLASH_SALE",
            campaignId: null,
            productDiscountId: null,
            flashSaleId: flashSale.id,
            quantity: 1,
            itemSubtotal: salePrice,
        };
    }

    const promoLanding = await prisma.promoLanding.findFirst({
        where: {
            variantId,
            isActive: true,
            startAt: { lte: now },
            endAt: { gte: now },
        },
        orderBy: { startAt: "desc" },
        select: { promoPrice: true },
    });
    if (promoLanding) {
        const promoPrice = Math.round(Number(promoLanding.promoPrice));
        if (promoPrice > 0 && promoPrice < originalPrice) {
            return {
                productId,
                variantId,
                originalPrice,
                finalPrice: promoPrice,
                discountAmount: originalPrice - promoPrice,
                discountType: "FIXED",
                source: "PROMO_LANDING",
                campaignId: null,
                productDiscountId: null,
                flashSaleId: null,
                quantity: 1,
                itemSubtotal: promoPrice,
            };
        }
    }

    // ==========================================
    // 3. PRODUCT DISCOUNT
    // ==========================================

    const productDiscount = await getActiveProductDiscount(
        productId,
        variantId,
        now
    );

    if (productDiscount) {
        const discountResult = calculateDiscountedPrice(
            originalPrice,
            productDiscount
        );

        return {
            productId,
            variantId,
            originalPrice,
            finalPrice: discountResult.finalPrice,
            discountAmount: discountResult.discountAmount,
            discountType: productDiscount.type,
            source: "PRODUCT_DISCOUNT",
            campaignId: null,
            productDiscountId: productDiscount.id,
            flashSaleId: null,
            quantity: 1,
            itemSubtotal: discountResult.finalPrice,
        };
    }

    // ==========================================
    // 3. CAMPAIGN DISCOUNT
    // ==========================================

    const campaign = await resolveCampaignForProduct(
        productId,
        productCategory,
        now
    );

    if (
        campaign &&
        campaign.discountType &&
        campaign.discountValue &&
        isCampaignActive(campaign, now)
    ) {
        const campaignDiscountValue = Number(campaign.discountValue);
        let discountAmount = 0;

        if (campaign.discountType === "PERCENTAGE") {
            discountAmount = (originalPrice * campaignDiscountValue) / 100;

            if (campaign.maxDiscount) {
                const maxDiscount = Number(campaign.maxDiscount);
                if (discountAmount > maxDiscount) {
                    discountAmount = maxDiscount;
                }
            }
        } else {
            discountAmount = campaignDiscountValue;
        }

        // Never allow negative final price
        discountAmount = Math.min(discountAmount, originalPrice);
        discountAmount = Math.round(discountAmount);

        const finalPrice = originalPrice - discountAmount;

        return {
            productId,
            variantId,
            originalPrice,
            finalPrice,
            discountAmount,
            discountType: campaign.discountType as Voucher_type,
            source: "CAMPAIGN_DISCOUNT",
            campaignId: campaign.id,
            productDiscountId: null,
            flashSaleId: null,
            quantity: 1,
            itemSubtotal: finalPrice,
        };
    }

    // ==========================================
    // 4. ORIGINAL PRICE (no discount)
    // ==========================================

    return {
        productId,
        variantId,
        originalPrice,
        finalPrice: originalPrice,
        discountAmount: 0,
        discountType: null,
        source: "ORIGINAL",
        campaignId: null,
        productDiscountId: null,
        flashSaleId: null,
        quantity: 1,
        itemSubtotal: originalPrice,
    };
}

/**
 * Resolve campaign discount for a specific product.
 *
 * Returns the campaign discount details if a campaign applies.
 */
export async function resolveCampaignDiscount(
    productId: number,
    variantId: number,
    productCategory: string | null,
    now: Date = new Date()
) {
    const campaign = await resolveCampaignForProduct(
        productId,
        productCategory,
        now
    );

    if (!campaign) {
        return null;
    }

    if (!campaign.discountType || !campaign.discountValue) {
        return null;
    }

    if (!isCampaignActive(campaign, now)) {
        return null;
    }

    return {
        campaignId: campaign.id,
        campaignName: campaign.name,
        discountType: campaign.discountType,
        discountValue: Number(campaign.discountValue),
        maxDiscount: campaign.maxDiscount
            ? Number(campaign.maxDiscount)
            : null,
    };
}

// ==========================================
// ORDER-LEVEL PRICING
// ==========================================

export type PricingItemInput = {
    productId: number;
    variantId: number;
    quantity: number;
    category?: string | null;
};

/**
 * Calculate pricing for all items in an order.
 *
 * Fetches authoritative prices from database for each item.
 * Never trusts client-sent prices.
 *
 * @param items - Cart/checkout items (productIds and variantIds from client,
 *                but prices fetched from database)
 * @param now - Current time
 * @returns Complete order pricing breakdown
 */
export async function calculateItemPricing(
    items: PricingItemInput[],
    now: Date = new Date()
): Promise<OrderPricingResult> {
    const results: ItemPricingResult[] = [];
    let originalSubtotal = 0;
    let finalSubtotal = 0;

    for (const item of items) {
        // Fetch variant and product from database (authoritative source)
        const variant = await prisma.productVariant.findUnique({
            where: { id: item.variantId },
            include: { product: true },
        });

        if (!variant) {
            throw new Error(
                `Variant ${item.variantId} tidak ditemukan.`
            );
        }

        // Use database price, never trust client
        const originalPrice = Number(variant.price);
        const productCategory = item.category ?? variant.product.category;

        // Resolve price for this item
        const pricing = await resolveProductPrice(
            item.variantId,
            item.productId,
            productCategory,
            now
        );

        // Apply quantity
        pricing.quantity = item.quantity;
        pricing.itemSubtotal = pricing.finalPrice * item.quantity;

        originalSubtotal += originalPrice * item.quantity;
        finalSubtotal += pricing.itemSubtotal;

        results.push(pricing);
    }

    const totalDiscount = originalSubtotal - finalSubtotal;

    return {
        items: results,
        originalSubtotal,
        finalSubtotal,
        totalDiscount,
    };
}

/**
 * Calculate complete order pricing including shipping and voucher.
 *
 * This is the final pricing calculation before order creation.
 *
 * @param items - Cart/checkout items
 * @param shippingCost - Shipping cost (from server)
 * @param voucherDiscount - Voucher discount (from server-side validation)
 * @param now - Current time
 * @returns Complete order pricing with gross amount
 */
export async function calculateOrderPricing(
    items: PricingItemInput[],
    shippingCost: number,
    voucherDiscount: number,
    now: Date = new Date()
) {
    const itemPricing = await calculateItemPricing(items, now);

    const subtotal = itemPricing.finalSubtotal;
    const discount = voucherDiscount;
    const grossAmount = subtotal - discount + shippingCost;

    // Ensure gross amount is valid
    if (!Number.isFinite(grossAmount) || grossAmount < 0) {
        throw new Error("Total pembayaran tidak valid.");
    }

    return {
        ...itemPricing,
        shippingCost,
        voucherDiscount: discount,
        subtotal,
        grossAmount: Math.round(grossAmount),
    };
}

// ==========================================
// HELPER: GET PRICE FOR DISPLAY
// ==========================================

/**
 * Get the display price for a product/variant.
 *
 * Returns the effective price considering all discounts.
 * Used for product listings, cart display, etc.
 *
 * @param variantId - Product variant ID
 * @param now - Current time
 * @returns Price information for display
 */
export async function getDisplayPrice(
    variantId: number,
    now: Date = new Date()
) {
    const variant = await prisma.productVariant.findUnique({
        where: { id: variantId },
        include: { product: true },
    });

    if (!variant) {
        return null;
    }

    const pricing = await resolveProductPrice(
        variantId,
        variant.productId,
        variant.product.category,
        now
    );

    return {
        originalPrice: pricing.originalPrice,
        finalPrice: pricing.finalPrice,
        discountAmount: pricing.discountAmount,
        hasDiscount: pricing.discountAmount > 0,
        source: pricing.source,
    };
}
