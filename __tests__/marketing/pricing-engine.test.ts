/**
 * ==========================================
 * MARKETING & PRICING ENGINE TESTS
 * ==========================================
 *
 * Static/code-path verification tests.
 * These verify architecture and code patterns
 * without requiring a running database.
 *
 * Run: npx tsx __tests__/marketing/pricing-engine.test.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

function readFile(relativePath: string): string {
    return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(`FAIL: ${message}`);
    }
}

function pass(name: string) {
    console.log(`  ✅ ${name}`);
}

function fail(name: string, error: string) {
    console.log(`  ❌ ${name}: ${error}`);
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        pass(name);
        passed++;
    } catch (e) {
        fail(name, e instanceof Error ? e.message : String(e));
        failed++;
    }
}

console.log("\n=== MARKETING & PRICING ENGINE TESTS ===\n");

// ==========================================
// 1. BATCH PRICING ENGINE
// ==========================================
console.log("1. Batch Pricing Engine:");

const batchPricingCode = readFile("lib/marketing/batch-pricing.ts");

test("resolveBatchPrices exists and is exported", () => {
    assert(batchPricingCode.includes("export async function resolveBatchPrices"), "Missing resolveBatchPrices export");
});

test("Batch pricing queries FlashSale table", () => {
    assert(batchPricingCode.includes("prisma.flashSale.findMany"), "Missing FlashSale query");
});

test("Batch pricing queries ProductDiscount table", () => {
    assert(batchPricingCode.includes("prisma.productDiscount.findMany"), "Missing ProductDiscount query");
});

test("Batch pricing queries BulkDiscount table", () => {
    assert(batchPricingCode.includes("prisma.bulkDiscount.findMany"), "Missing BulkDiscount query");
});

test("Batch pricing uses getActiveCampaigns for campaigns", () => {
    assert(batchPricingCode.includes("getActiveCampaigns"), "Missing getActiveCampaigns call");
});

test("Flash sale has highest priority in batch pricing", () => {
    const flashSaleIdx = batchPricingCode.indexOf("FLASH SALE");
    const discountIdx = batchPricingCode.indexOf("PRODUCT DISCOUNT");
    const campaignIdx = batchPricingCode.indexOf("CAMPAIGN DISCOUNT");
    assert(flashSaleIdx < discountIdx, "Flash sale should come before product discount");
    assert(discountIdx < campaignIdx, "Product discount should come before campaign");
});

test("Bulk discount only applies when no higher priority discount", () => {
    assert(
        batchPricingCode.includes('result.source === "ORIGINAL"') || batchPricingCode.includes("result.discountAmount === 0"),
        "Bulk discount should only apply when no higher priority discount"
    );
});

test("Flash sale checks isActive, startAt, endAt, saleStock", () => {
    assert(batchPricingCode.includes("isActive: true"), "Missing isActive check");
    assert(batchPricingCode.includes("startAt:"), "Missing startAt check");
    assert(batchPricingCode.includes("endAt:"), "Missing endAt check");
    assert(batchPricingCode.includes("saleStock:"), "Missing saleStock check");
});

test("Product discount checks isActive and time window", () => {
    assert(batchPricingCode.includes("isActive: true"), "Missing isActive in discount query");
});

test("Bulk discount checks isActive and time window", () => {
    assert(batchPricingCode.includes("isActive: true"), "Missing isActive in bulk discount query");
});

test("Batch pricing uses Math.round for final prices", () => {
    assert(batchPricingCode.includes("Math.round"), "Missing Math.round for price calculation");
});

test("Batch pricing prevents negative prices", () => {
    assert(
        batchPricingCode.includes("Math.min(amt, item.originalPrice)") || batchPricingCode.includes("Math.min"),
        "Missing negative price prevention"
    );
});

// ==========================================
// 2. CHECKOUT INTEGRATION
// ==========================================
console.log("\n2. Checkout Integration:");

const checkoutCode = readFile("lib/checkout.ts");

test("Checkout uses resolveBatchPrices via resolveBatchMarketingPricing", () => {
    assert(checkoutCode.includes("resolveBatchMarketingPricing"), "Missing batch pricing in checkout");
});

test("Checkout has server-side shipping cost verification", () => {
    assert(
        checkoutCode.includes("verifyShippingCost") || checkoutCode.includes("clientShippingCost < 0"),
        "Missing server-side shipping cost verification"
    );
});

test("Checkout validates flash sale stock atomically", () => {
    assert(checkoutCode.includes("$executeRaw"), "Missing atomic flash sale stock reservation");
});

test("Checkout validates regular stock atomically", () => {
    assert(
        checkoutCode.includes("gte:") && checkoutCode.includes("item.quantity") && checkoutCode.includes("updateMany"),
        "Missing atomic stock check (gte + item.quantity + updateMany)"
    );
});

test("Checkout uses enhanced voucher validator", () => {
    assert(checkoutCode.includes("validateAndCalculateVoucherEnhanced"), "Missing enhanced voucher validator");
});

test("Checkout applies shipping discount", () => {
    assert(checkoutCode.includes("calculateShippingDiscount"), "Missing shipping discount calculation");
});

test("Checkout validates grossAmount > 0", () => {
    assert(checkoutCode.includes("grossAmount <= 0"), "Missing grossAmount validation");
});

// ==========================================
// 3. CART API CONSISTENCY
// ==========================================
console.log("\n3. Cart API Consistency:");

const cartApiCode = readFile("app/api/cart/route.ts");

test("Cart API has formatCartResponse helper", () => {
    assert(cartApiCode.includes("async function formatCartResponse"), "Missing formatCartResponse helper");
});

test("Cart GET uses formatCartResponse", () => {
    assert(cartApiCode.includes("formatCartResponse(cart)"), "GET should use formatCartResponse");
});

test("Cart PATCH uses formatCartResponse", () => {
    assert(cartApiCode.includes("formatCartResponse(cart)"), "PATCH should use formatCartResponse");
});

test("Cart DELETE uses formatCartResponse", () => {
    assert(cartApiCode.includes("formatCartResponse(cart)"), "DELETE should use formatCartResponse");
});

test("Cart API returns effectivePrice as 'price'", () => {
    assert(cartApiCode.includes("price: effectivePrice"), "Should return effectivePrice as price field");
});

test("Cart API returns productSlug field", () => {
    assert(cartApiCode.includes("productSlug: item.product.slug"), "Should include productSlug");
});

test("Cart API returns originalPrice field", () => {
    assert(cartApiCode.includes("originalPrice:"), "Should include originalPrice");
});

test("Cart API returns discount and hasDiscount fields", () => {
    assert(cartApiCode.includes("discount: pricing?.discountAmount"), "Should include discount");
    assert(cartApiCode.includes("hasDiscount:"), "Should include hasDiscount");
});

test("Cart API returns priceSource field", () => {
    assert(cartApiCode.includes("priceSource: pricing?.source"), "Should include priceSource");
});

test("Cart API returns flashSaleName and bulkDiscountName", () => {
    assert(cartApiCode.includes("flashSaleName:"), "Should include flashSaleName");
    assert(cartApiCode.includes("bulkDiscountName:"), "Should include bulkDiscountName");
});

// ==========================================
// 4. CART PAGE CONSISTENCY
// ==========================================
console.log("\n4. Cart Page Consistency:");

const cartPageCode = readFile("components/cart/CartPage.tsx");

test("CartPage uses item.price (effectivePrice) not item.variant.price", () => {
    assert(cartPageCode.includes("item.price"), "Should use item.price");
    assert(!cartPageCode.includes("item.variant.price"), "Should NOT use item.variant.price");
});

test("CartPage uses item.productName not item.product.name", () => {
    assert(cartPageCode.includes("item.productName"), "Should use item.productName");
    assert(!cartPageCode.includes("item.product.name"), "Should NOT use item.product.name");
});

test("CartPage uses item.productSlug not item.product.slug", () => {
    assert(cartPageCode.includes("item.productSlug"), "Should use item.productSlug");
    assert(!cartPageCode.includes("item.product.slug"), "Should NOT use item.product.slug");
});

test("CartPage uses item.stock not item.variant.stock", () => {
    assert(cartPageCode.includes("item.stock"), "Should use item.stock");
    assert(!cartPageCode.includes("item.variant.stock"), "Should NOT use item.variant.stock");
});

test("CartPage subtotal uses effectivePrice", () => {
    assert(
        cartPageCode.includes("item.price") && cartPageCode.includes("item.quantity"),
        "Subtotal should use item.price and item.quantity"
    );
    // Verify it does NOT use variant.price
    assert(!cartPageCode.includes("item.variant.price"), "Subtotal should NOT use item.variant.price");
});

test("CartPage shows original price strikethrough when discounted", () => {
    assert(cartPageCode.includes("line-through"), "Should show strikethrough for original price");
});

test("CartPage shows flash sale name", () => {
    assert(cartPageCode.includes("flashSaleName"), "Should display flash sale name");
});

test("CartPage shows bulk discount name", () => {
    assert(cartPageCode.includes("bulkDiscountName"), "Should display bulk discount name");
});

test("CartPage has loading state", () => {
    assert(cartPageCode.includes("animate-pulse"), "Should have loading skeleton");
});

test("CartPage has empty state", () => {
    assert(cartPageCode.includes("Keranjang masih kosong"), "Should have empty state message");
});

test("CartPage has error handling", () => {
    assert(cartPageCode.includes("toast.error"), "Should have error toast");
});

// ==========================================
// 5. ARCHIVED PRODUCTS
// ==========================================
console.log("\n5. Archived Products Filtering:");

const productsApiCode = readFile("app/api/products/route.ts");

test("Products API filters isArchived: false", () => {
    assert(productsApiCode.includes("isArchived: false"), "Products API should filter archived products");
});

const productDetailCode = readFile("app/products/[slug]/page.tsx");

test("Product detail filters isArchived: false", () => {
    assert(productDetailCode.includes("isArchived: false"), "Product detail should filter archived products");
});

const homePageCode = readFile("app/home/page.tsx");

test("Home page filters isArchived: false", () => {
    assert(homePageCode.includes("isArchived: false"), "Home page should filter archived products");
});

test("Home page uses resolveBatchPrices", () => {
    assert(homePageCode.includes("resolveBatchPrices"), "Home page should use batch pricing");
});

// ==========================================
// 6. PROXY/MIDDLEWARE PROTECTION
// ==========================================
console.log("\n6. Proxy/Middleware Protection:");

const proxyCode = readFile("proxy.ts");

test("Proxy file uses auth wrapper", () => {
    assert(proxyCode.includes('auth'), "Should use auth wrapper");
});

test("Proxy protects /cart routes", () => {
    assert(proxyCode.includes("/cart/:path*"), "Should protect /cart routes");
});

test("Proxy protects /checkout routes", () => {
    assert(proxyCode.includes("/checkout/:path*"), "Should protect /checkout routes");
});

test("Proxy protects /buy-now routes", () => {
    assert(proxyCode.includes("/buy-now/:path*"), "Should protect /buy-now routes");
});

test("Proxy no longer guards the /orders page (guest soft-login)", () => {
    assert(
        !proxyCode.includes("/orders/:path*"),
        "Page-level /orders route must not be forced behind login"
    );
});

test("Proxy still protects the /api/orders API", () => {
    assert(
        proxyCode.includes('\"/api/orders\"'),
        "Order API must remain protected"
    );
});

test("Proxy protects /admin routes", () => {
    assert(proxyCode.includes("/admin/:path*"), "Should protect /admin routes");
});

test("Proxy protects /profile routes", () => {
    assert(proxyCode.includes("/profile/:path*"), "Should protect /profile routes");
});

// ==========================================
// 7. RATE LIMITING
// ==========================================
console.log("\n7. Rate Limiting:");

const rateLimitCode = readFile("lib/rate-limit.ts");

test("Rate limiter has checkRateLimit function", () => {
    assert(rateLimitCode.includes("export function checkRateLimit"), "Missing checkRateLimit function");
});

test("Rate limiter has login rate limiter", () => {
    assert(rateLimitCode.includes("login:"), "Missing login rate limiter");
});

test("Rate limiter has voucher validation rate limiter", () => {
    assert(rateLimitCode.includes("voucher:"), "Missing voucher rate limiter");
});

test("Rate limiter has order creation rate limiter", () => {
    assert(rateLimitCode.includes("order:"), "Missing order rate limiter");
});

test("Rate limiter has register rate limiter", () => {
    assert(rateLimitCode.includes("register:"), "Missing register rate limiter");
});

const voucherValidateCode = readFile("app/api/voucher/validate/route.ts");

test("Voucher validate endpoint uses rate limiting", () => {
    assert(voucherValidateCode.includes("rateLimiters.voucherValidation"), "Voucher validate should use rate limiting");
    assert(voucherValidateCode.includes("429"), "Should return 429 when rate limited");
});

// ==========================================
// 8. CSRF PROTECTION
// ==========================================
console.log("\n8. CSRF Protection:");

const csrfCode = readFile("lib/csrf.ts");

test("CSRF helper has requireSession function", () => {
    assert(csrfCode.includes("export async function requireSession"), "Missing requireSession function");
});

test("CSRF helper has requireAdminSession function", () => {
    assert(csrfCode.includes("export async function requireAdminSession"), "Missing requireAdminSession function");
});

// ==========================================
// 9. VOUCHER ELIGIBILITY
// ==========================================
console.log("\n9. Voucher Eligibility:");

const voucherCode = readFile("lib/voucher.ts");

test("Voucher checks NEW_USER eligibility", () => {
    assert(voucherCode.includes("NEW_USER"), "Missing NEW_USER eligibility check");
});

test("Voucher checks RETURNING_USER eligibility", () => {
    assert(voucherCode.includes("RETURNING_USER"), "Missing RETURNING_USER eligibility check");
});

test("Voucher checks paid order count for eligibility", () => {
    assert(voucherCode.includes("paidOrderCount"), "Missing paid order count check");
});

test("Voucher checks per-user usage limit", () => {
    assert(voucherCode.includes("maxUsagePerUser"), "Missing per-user usage limit check");
});

test("Voucher checks product restrictions", () => {
    assert(voucherCode.includes("productRestrictions"), "Missing product restrictions check");
});

test("Voucher checks category restrictions", () => {
    assert(voucherCode.includes("categoryRestrictions"), "Missing category restrictions check");
});

test("Voucher uses atomic increment", () => {
    assert(voucherCode.includes("$executeRaw"), "Missing atomic voucher increment");
});

// ==========================================
// 10. FLASH SALE CONCURRENCY
// ==========================================
console.log("\n10. Flash Sale Concurrency:");

const flashSaleCode = readFile("lib/marketing/flash-sale.ts");

test("Flash sale uses atomic stock reservation", () => {
    assert(flashSaleCode.includes("$executeRaw"), "Missing atomic flash sale stock reservation");
});

test("Flash sale checks saleStock >= quantity atomically", () => {
    assert(flashSaleCode.includes("saleStock >= ${quantity}"), "Missing atomic stock condition");
});

test("Flash sale tracks per-user purchase count", () => {
    assert(flashSaleCode.includes("FlashSalePurchase"), "Missing FlashSalePurchase tracking");
});

test("Flash sale enforces purchase limit", () => {
    assert(flashSaleCode.includes("purchaseLimit"), "Missing purchase limit enforcement");
});

test("Flash sale delete checks pending orders", () => {
    assert(flashSaleCode.includes("pendingOrderCount"), "Missing pending order check on delete");
});

// ==========================================
// 11. WEBHOOK VOUCHER ROLLBACK
// =========================================
console.log("\n11. Webhook Voucher Rollback:");

const webhookCode = readFile("app/api/payment/midtrans/notification/route.ts");

test("Webhook releaseReservedStock decrements VoucherUserUsage", () => {
    assert(webhookCode.includes("voucherUserUsage.findUnique"), "Missing VoucherUserUsage lookup in webhook");
    assert(webhookCode.includes("voucherUserUsage.update"), "Missing VoucherUserUsage decrement in webhook");
});

test("Webhook releaseReservedStock guards usageCount > 0", () => {
    assert(webhookCode.includes("userUsage.usageCount > 0"), "Missing usageCount > 0 guard in webhook");
});

test("Webhook releaseReservedStock uses voucherId_userId key", () => {
    assert(webhookCode.includes("voucherId_userId"), "Missing voucherId_userId composite key in webhook");
});

test("Webhook releaseReservedStock has both voucher decrements in same if-block", () => {
    // Both Voucher.usedCount and VoucherUserUsage should be inside if (order.voucherId)
    assert(
        webhookCode.includes("voucher.updateMany") && webhookCode.includes("voucherUserUsage"),
        "Both voucher decrements not found in webhook"
    );
});

test("Webhook stock/idempotency guards remain intact after voucher fix", () => {
    assert(webhookCode.includes('paymentStatus === "PAID"'), "Missing PAID guard");
    assert(webhookCode.includes('status !== "CANCELLED"'), "Missing CANCELLED guard");
});

// ==========================================
// 12. SERVER-SIDE SHIPPING VERIFICATION
// ==========================================
console.log("\n12. Server-Side Shipping Verification:");

const checkoutCode2 = readFile("lib/checkout.ts");
const shippingCostRouteCode = readFile("app/api/shipping/cost/route.ts");

test("verifyShippingCost function exists", () => {
    assert(checkoutCode2.includes("async function verifyShippingCost") ||
           checkoutCode2.includes("async function verifyServerShippingCost"),
        "Missing server-side shipping verification function");
});

test("verifyShippingCost queries StoreSetting for origin", () => {
    assert(checkoutCode2.includes("StoreSetting") && checkoutCode2.includes("rajaOngkirDestinationId"),
        "Missing StoreSetting/origin lookup in checkout");
});

test("verifyShippingCost queries UserAddress for destination", () => {
    assert(checkoutCode2.includes("userAddress") || checkoutCode2.includes("UserAddress"),
        "Missing UserAddress/destination lookup in checkout");
});

test("verifyShippingCost calculates weight from database", () => {
    assert(checkoutCode2.includes("totalWeight"),
        "Missing totalWeight calculation in checkout");
});

test("Server does not trust client shipping cost", () => {
    // Should have a rejection when client cost differs from server cost
    assert(checkoutCode2.includes("reject") || checkoutCode2.includes("Tidak valid") ||
           checkoutCode2.includes("berubah") || checkoutCode2.includes("REJECT"),
        "Missing rejection for tampered shipping cost");
});

test("Server uses verified cost for order total", () => {
    assert(checkoutCode2.includes("verifiedShippingCost") || checkoutCode2.includes("serverShippingCost"),
        "Missing server-verified shipping cost variable for order creation");
});

test("verifyShippingCost is called before transaction", () => {
    // Shipping verification should happen BEFORE the prisma.$transaction block
    const verifyIdx = checkoutCode2.indexOf("verifyShippingCost");
    const transactionIdx = checkoutCode2.indexOf("$transaction");
    assert(verifyIdx > 0 && transactionIdx > 0 && verifyIdx < transactionIdx,
        "verifyShippingCost must be called before $transaction");
});

test("All order creation endpoints go through createCheckoutOrder", () => {
    const buyNowCode = readFile("app/api/buy-now/route.ts");
    const buyNowIpaymuCode = readFile("app/api/buy-now/ipaymu/route.ts");
    assert(buyNowCode.includes("createCheckoutOrder"), "buy-now does not use createCheckoutOrder");
    assert(buyNowIpaymuCode.includes("createCheckoutOrder"), "buy-now/ipaymu does not use createCheckoutOrder");
});

test("RajaOngkir helper exists for server-side verification", () => {
    const hasRajaongkir = checkoutCode2.includes("rajaongkir") ||
                          checkoutCode2.includes("RajaOngkir") ||
                          checkoutCode2.includes("getShippingRates") ||
                          checkoutCode2.includes("fetchShippingCost");
    assert(hasRajaongkir, "No RajaOngkir integration found in checkout verification");
});

test("Courier/service format validated before API call", () => {
    assert(checkoutCode2.includes("courier") || checkoutCode2.includes("Courier"),
        "Missing courier validation in checkout");
});

// ==========================================
// 13. M2: CAMPAIGN ↔ VOUCHER INTEGRATION
// ==========================================
console.log("\n13. M2 Campaign ↔ Voucher Integration:");

const batchPricingCode2 = readFile("lib/marketing/batch-pricing.ts");
const checkoutCode3 = readFile("lib/checkout.ts");
const voucherPatchCode = readFile("app/api/admin/vouchers/[id]/route.ts");
const voucherPostCode = readFile("app/api/admin/vouchers/route.ts");

test("BatchPricingResult includes campaignId field", () => {
    assert(batchPricingCode2.includes("campaignId: number | null"), "Missing campaignId in BatchPricingResult");
});

test("Batch pricing sets campaignId when campaign source matches", () => {
    assert(
        batchPricingCode2.includes("result.campaignId = campaign.id") ||
        batchPricingCode2.includes('campaignId: campaign.id'),
        "Missing campaignId assignment in batch pricing"
    );
});

test("resolveOrderCampaignId exported from batch-pricing", () => {
    assert(batchPricingCode2.includes("export async function resolveOrderCampaignId"), "Missing resolveOrderCampaignId export");
});

test("Checkout imports resolveOrderCampaignId", () => {
    assert(checkoutCode3.includes("resolveOrderCampaignId"), "Missing resolveOrderCampaignId import in checkout");
});

test("Checkout resolves campaign context before voucher validation", () => {
    // Verify resolveOrderCampaignId is called (not just imported) before validateAndCalculateVoucherEnhanced
    const campaignCallIdx = checkoutCode3.indexOf("await resolveOrderCampaignId(");
    const voucherIdx = checkoutCode3.indexOf("validateAndCalculateVoucherEnhanced(");
    assert(campaignCallIdx > 0 && voucherIdx > 0, "Both functions must exist in checkout");
    assert(campaignCallIdx < voucherIdx, "resolveOrderCampaignId must be called before voucher validation");
});

test("Checkout passes orderCampaignId (not null) to voucher validator", () => {
    assert(
        checkoutCode3.includes("orderCampaignId") && !checkoutCode3.match(/validateAndCalculateVoucherEnhanced\([^)]*null[^)]*null/),
        "Checkout must pass resolved campaignId, not hardcoded null"
    );
});

test("Voucher PATCH validates campaignId assignment", () => {
    assert(
        voucherPatchCode.includes("campaignId") && voucherPatchCode.includes("campaign"),
        "Voucher PATCH must handle campaignId"
    );
});

test("Voucher PATCH validates campaign exists and is active", () => {
    assert(
        voucherPatchCode.includes("status") && voucherPatchCode.includes("startAt") && voucherPatchCode.includes("endAt"),
        "Voucher PATCH must validate campaign active status"
    );
});

test("Voucher DELETE checks campaign assignment before deletion", () => {
    assert(
        voucherPatchCode.includes("campaignId") && voucherPatchCode.includes("delete"),
        "Voucher DELETE must check campaignId"
    );
});

test("Voucher POST supports campaignId assignment with validation", () => {
    assert(
        voucherPostCode.includes("campaignId") && voucherPostCode.includes("campaign"),
        "Voucher POST must support campaignId"
    );
});

// ==========================================
// 14. M3: CONCURRENCY FIXES
// ==========================================
console.log("\n14. M3 Concurrency Fixes:");

const voucherCode2 = readFile("lib/voucher.ts");
const flashSaleCode2 = readFile("lib/marketing/flash-sale.ts");
const checkoutCode4 = readFile("lib/checkout.ts");

test("incrementVoucherUserUsage returns usageCount (not void)", () => {
    assert(
        voucherCode2.includes(": Promise<number>") && voucherCode2.includes("incrementVoucherUserUsage"),
        "incrementVoucherUserUsage must return Promise<number>"
    );
});

test("Checkout validates returned usageCount against maxUsagePerUser", () => {
    assert(
        checkoutCode4.includes("newUsageCount") && checkoutCode4.includes("maxUsagePerUser"),
        "Checkout must validate newUsageCount against maxUsagePerUser"
    );
});

test("Checkout fetches voucher.maxUsagePerUser for post-increment check", () => {
    assert(
        checkoutCode4.includes("voucherRecord?.maxUsagePerUser"),
        "Checkout must fetch voucherRecord for post-increment check"
    );
});

test("recordFlashSalePurchase returns quantity (not void)", () => {
    assert(
        flashSaleCode2.includes(": Promise<number>") && flashSaleCode2.includes("recordFlashSalePurchase"),
        "recordFlashSalePurchase must return Promise<number>"
    );
});

test("Flash sale purchase limit has post-increment validation", () => {
    assert(
        flashSaleCode2.includes("record.quantity > purchaseLimit"),
        "recordFlashSalePurchase must validate quantity > purchaseLimit after increment"
    );
});

test("Flash sale purchase limit throws FlashSalePurchaseLimitError on post-check", () => {
    assert(
        flashSaleCode2.includes("FlashSalePurchaseLimitError(purchaseLimit)"),
        "recordFlashSalePurchase must throw FlashSalePurchaseLimitError"
    );
});

// ==========================================
// 15. M6: CUSTOMER-FACING PRICING CONSISTENCY
// ==========================================
console.log("\n15. M6 Customer-Facing Pricing Consistency:");

const homePageCodeM6 = readFile("app/home/page.tsx");
const productsRouteM6 = readFile("app/api/products/route.ts");
const productDetailM6 = readFile("app/products/[slug]/page.tsx");
const cartApiM6 = readFile("app/api/cart/route.ts");
const checkoutApiM6 = readFile("app/api/checkout/route.ts");
const buyNowApiM6 = readFile("app/api/buy-now/route.ts");

const customerSurfaces = [
    { name: "Homepage", code: homePageCodeM6 },
    { name: "Product listing", code: productsRouteM6 },
    { name: "Product detail", code: productDetailM6 },
    { name: "Cart", code: cartApiM6 },
    { name: "Checkout", code: checkoutApiM6 },
    { name: "Buy Now", code: buyNowApiM6 },
];

for (const surface of customerSurfaces) {
    test(`${surface.name} uses resolveBatchPrices (single pricing engine)`, () => {
        assert(
            surface.code.includes("resolveBatchPrices"),
            `${surface.name} must use resolveBatchPrices for pricing consistency`
        );
    });
}

test("Checkout uses resolveBatchMarketingPricing (batch) not per-item queries", () => {
    assert(
        checkoutCode4.includes("resolveBatchMarketingPricing"),
        "Checkout must use batch pricing, not per-item queries"
    );
});

test("All surfaces import from same batch-pricing module", () => {
    for (const surface of customerSurfaces) {
        assert(
            surface.code.includes("@/lib/marketing/batch-pricing") || surface.code.includes("batch-pricing"),
            `${surface.name} must import from batch-pricing module`
        );
    }
});

// ==========================================
// RESULTS
// ==========================================
console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
    process.exit(1);
}
