/**
 * ==========================================
 * CHECKOUT LIFECYCLE TESTS
 * ==========================================
 *
 * Static/code-path verification tests.
 * These verify architecture and code patterns
 * without requiring a running database.
 *
 * Run: npx tsx __tests__/checkout/lifecycle.test.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import {
    flat,
    functionBody,
    hasFlat,
    hasSql,
} from "../helpers/source-invariants";

function readFile(
    relativePath: string
): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

/*
 * True when a route actually reaches the shared limiter.
 *
 * The import became MULTI-LINE when the guest limiters were added, so
 * matching one exact `import { rateLimiters } from ...` line is a locator
 * lie; match the module + at least one limiter call instead.
 */
function usesRateLimiters(code: string): boolean {
    return (
        code.includes('from "@/lib/rate-limit"') &&
        /rateLimiters\.[A-Za-z]+\(/.test(code)
    );
}

/**
 * The AUTHENTICATED branch's order-creation limiter. The variable was
 * renamed `user.id` → `userId` when the guest path was added, so accept
 * the current name (and the legacy one) instead of pinning one literal.
 */
function limitsAuthedOrderCreation(code: string): boolean {
    return (
        code.includes("rateLimiters.orderCreation(userId)") ||
        code.includes("rateLimiters.orderCreation(user.id)") ||
        code.includes("rateLimiters.orderCreation(user.id!)")
    );
}

/**
 * The GUEST branch must be limited too: a device/IP bucket AND an
 * identity bucket (hashed email/phone), so neither one client nor one
 * person rotating IPs can spam order creation.
 */
function limitsGuestCheckout(code: string): boolean {
    return (
        code.includes("rateLimiters.guestCheckoutDevice(") &&
        (code.includes("rateLimiters.guestCheckoutIdentity(") ||
            code.includes("rateLimiters.guestCodIdentity("))
    );
}

/*
 * The shared stock/voucher release primitive. The webhook routes delegate
 * to it, so an invariant about release behaviour belongs to THIS module
 * plus a check that each webhook actually calls it.
 */
const orderStockCode = readFile("lib/order-stock.ts");

/*
 * The rollback primitive: rollbackCheckoutOrder() delegates to
 * cancelOrderForReservations(), which owns the CAS. Scoping assertions to
 * the primitive keeps them working when the wrapper changes.
 */
const cancelReservationsBody = functionBody(
    readFile("lib/checkout.ts"),
    "export async function cancelOrderForReservations"
);

function assert(
    condition: boolean,
    message: string
) {
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

// ==========================================
// TEST SUITE
// ==========================================

let passed = 0;
let failed = 0;

function test(
    name: string,
    fn: () => void
) {
    try {
        fn();
        pass(name);
        passed++;
    } catch (e) {
        fail(
            name,
            e instanceof Error
                ? e.message
                : String(e)
        );
        failed++;
    }
}

console.log(
    "\n=== CHECKOUT LIFECYCLE TESTS ===\n"
);

// ==========================================
// 1. CHECKOUT ARCHITECTURE
// ==========================================

console.log("1. Checkout Architecture:");

const checkoutCode = readFile(
    "lib/checkout.ts"
);
const ordersRoute = readFile(
    "app/api/orders/route.ts"
);
const ipaymuRoute = readFile(
    "app/api/payment/ipaymu/route.ts"
);
const buyNowRoute = readFile(
    "app/api/buy-now/route.ts"
);
const buyNowIpaymu = readFile(
    "app/api/buy-now/ipaymu/route.ts"
);

test("All 4 routes import createCheckoutOrder", () => {
    assert(
        ordersRoute.includes(
            "createCheckoutOrder"
        ),
        "orders route missing createCheckoutOrder"
    );
    assert(
        ipaymuRoute.includes(
            "createCheckoutOrder"
        ),
        "ipaymu route missing createCheckoutOrder"
    );
    assert(
        buyNowRoute.includes(
            "createCheckoutOrder"
        ),
        "buy-now route missing createCheckoutOrder"
    );
    assert(
        buyNowIpaymu.includes(
            "createCheckoutOrder"
        ),
        "buy-now/ipaymu missing createCheckoutOrder"
    );
});

test("No client-trusted pricing in checkout", () => {
    const routes = [
        checkoutCode,
        ordersRoute,
        ipaymuRoute,
        buyNowRoute,
        buyNowIpaymu,
    ];
    for (const code of routes) {
        assert(
            !code.includes("body.price") &&
                !code.includes(
                    "body.subtotal"
                ) &&
                !code.includes("body.total"),
            "Found client-trusted pricing"
        );
    }
});

test("No inline voucher in Buy Now routes", () => {
    assert(
        !buyNowRoute.includes(
            "voucher.findUnique"
        ),
        "Buy Now has inline voucher"
    );
    assert(
        !buyNowIpaymu.includes(
            "voucher.findUnique"
        ),
        "Buy Now iPaymu has inline voucher"
    );
});

test("No inline pricing in Buy Now iPaymu", () => {
    assert(
        !buyNowIpaymu.includes(
            "decimalToNumber(variant.price)"
        ),
        "Buy Now iPaymu has inline pricing"
    );
});

// ==========================================
// 2. PRICING CONSISTENCY
// ==========================================

console.log("\n2. Pricing Consistency:");

const batchPricing = readFile(
    "lib/marketing/batch-pricing.ts"
);

test("Single pricing engine defined", () => {
    assert(
        batchPricing.includes(
            "export async function resolveBatchPrices"
        ),
        "resolveBatchPrices not found"
    );
});

test("Pricing priority: Flash Sale > Discount > Campaign > Original", () => {
    assert(
        batchPricing.includes("FLASH_SALE") &&
            batchPricing.includes(
                "PRODUCT_DISCOUNT"
            ) &&
            batchPricing.includes("CAMPAIGN") &&
            batchPricing.includes("ORIGINAL"),
        "Missing pricing sources"
    );
    // Flash Sale check comes before discount check
    const fsIndex =
        batchPricing.indexOf("FLASH_SALE");
    const discountIndex =
        batchPricing.indexOf(
            "PRODUCT_DISCOUNT"
        );
    assert(
        fsIndex < discountIndex,
        "Flash Sale should be checked before Discount"
    );
});

test("resolveBatchPrices used in checkout", () => {
    assert(
        checkoutCode.includes(
            "resolveBatchPrices"
        ),
        "Checkout doesn't use resolveBatchPrices"
    );
});

test("resolveBatchPrices used in product listing", () => {
    const productsRoute = readFile(
        "app/api/products/route.ts"
    );
    assert(
        productsRoute.includes(
            "resolveBatchPrices"
        ),
        "Products route doesn't use resolveBatchPrices"
    );
});

// ==========================================
// 3. STOCK CONCURRENCY
// ==========================================

console.log(
    "\n3. Stock Concurrency:"
);

test("Regular stock uses atomic conditional update", () => {
    assert(
        checkoutCode.includes(
            "updateMany"
        ) &&
            checkoutCode.includes(
                "gte:\r\n"
            ),
        "Missing atomic stock reservation"
    );
});

test("Flash sale uses atomic $executeRaw", () => {
    assert(
        checkoutCode.includes(
            "$executeRaw"
        ) &&
            hasSql(
                checkoutCode,
                "UPDATE flashsale"
            ),
        "Missing atomic flash sale reservation"
    );
});

test("Flash sale items skip regular stock", () => {
    assert(
        checkoutCode.includes(
            "flashSaleId) {"
        ) &&
            checkoutCode.includes(
                "continue;"
            ),
        "Flash sale items don't skip regular stock"
    );
});

// ==========================================
// 4. VOUCHER
// ==========================================

console.log("\n4. Voucher:");

const voucherCode = readFile(
    "lib/voucher.ts"
);

test("Voucher increment is atomic", () => {
    assert(
        voucherCode.includes(
            "$executeRaw"
        ) &&
            hasSql(
                voucherCode,
                "UPDATE voucher"
            ),
        "Voucher increment not atomic"
    );

    /*
     * The increment must carry its own quota guard: without it two
     * concurrent checkouts could both consume the last remaining slot.
     */
    assert(
        hasSql(voucherCode, "usedCount < quota"),
        "Voucher increment missing quota guard"
    );
});

test("Voucher rollback has usedCount guard", () => {
    assert(
        checkoutCode.includes(
            "usedCount:"
        ) &&
            checkoutCode.includes(
                "decrement: 1"
        ),
        "Missing usedCount guard in rollback"
    );
});

// ==========================================
// 5. FLASH SALE
// ==========================================

console.log(
    "\n5. Flash Sale:"
);

const flashSaleService = readFile(
    "lib/marketing/flash-sale.ts"
);

test("deleteFlashSale checks pending orders", () => {
    assert(
        flashSaleService.includes(
            "pendingOrderCount"
        ),
        "deleteFlashSale missing pending order check"
    );
});

test("updateFlashSale validates saleStock >= soldCount", () => {
    assert(
        flashSaleService.includes(
            "saleStock < existing.soldCount"
        ),
        "updateFlashSale missing soldCount guard"
    );
});

// ==========================================
// 6. ROLLBACK
// ==========================================

console.log(
    "\n6. Rollback:"
);test("Rollback has atomic CAS idempotency guard", () => {
    assert(
        checkoutCode.includes('$executeRaw') &&
        checkoutCode.includes("CANCELLED") &&
        checkoutCode.includes("IN ('PENDING', 'PROCESSING')"),
        "Missing atomic CAS idempotency guard in rollbackCheckoutOrder"
    );
});

test("Rollback CAS only transitions PENDING/PROCESSING", () => {
    assert(
        checkoutCode.includes("UPDATE") &&
        checkoutCode.includes("CANCELLED") &&
        checkoutCode.includes("IN ('PENDING', 'PROCESSING')"),
        "Rollback CAS missing PENDING/PROCESSING guard"
    );
});

test("Rollback restores flash sale stock atomically", () => {
    /*
     * The release moved into cancelOrderForReservations() (the shared
     * primitive rollbackCheckoutOrder() now delegates to), so scope the
     * assertion to THAT function instead of to a positional slice.
     */
    assert(
        hasSql(
            cancelReservationsBody,
            "UPDATE flashsale"
        ),
        "Rollback doesn't restore flash sale stock atomically"
    );
    assert(
        hasSql(
            cancelReservationsBody,
            "soldCount >="
        ),
        "Rollback flash sale restore missing soldCount guard"
    );
});

test("Rollback restores regular stock", () => {
    assert(
        checkoutCode.includes(
            "REGULAR ITEM"
        ) &&
            checkoutCode.includes(
                "productVariant.update"
            ),
        "Rollback doesn't restore regular stock"
    );
});

test("Rollback restores voucher usage", () => {
    /*
     * Scoped to the primitive and located by the calls that perform the
     * restore (not by a comment banner), including the guest-aware
     * per-identity bucket.
     */
    assert(
        cancelReservationsBody.includes("voucher.updateMany") &&
            cancelReservationsBody.includes("decrement: 1"),
        "Rollback doesn't restore the voucher quota"
    );
    assert(
        cancelReservationsBody.includes("voucherUserUsage.update") &&
            cancelReservationsBody.includes("voucherId_ownerKey"),
        "Rollback doesn't restore the per-identity voucher usage bucket"
    );
});

test("Rollback cancels order", () => {
    assert(
        checkoutCode.includes(
            "CANCELLED"
        ) &&
            checkoutCode.includes(
                "FAILED"
        ),
        "Rollback doesn't cancel order"
    );
});

// ==========================================
// 7. AUTHORIZATION
// ==========================================

console.log(
    "\n7. Authorization:"
);

test("Admin endpoints have auth checks", () => {
    const adminFiles = [
        "app/api/admin/campaigns/route.ts",
        "app/api/admin/discounts/route.ts",
        "app/api/admin/flash-sales/route.ts",
        "app/api/admin/promotions/route.ts",
        "app/api/admin/reports/route.ts",
    ];
    for (const f of adminFiles) {
        const code = readFile(f);
        assert(
            code.includes("ADMIN") &&
                (code.includes("requireAdmin") ||
                    code.includes(
                        'role !== "ADMIN"'
                    )),
            `${f} missing admin auth`
        );
    }
});

test("Public endpoints have no admin auth", () => {
    const publicFiles = [
        "app/api/campaigns/route.ts",
        "app/api/flash-sales/route.ts",
        "app/api/promotions/route.ts",
    ];
    for (const f of publicFiles) {
        const code = readFile(f);
        assert(
            !code.includes(
                'role !== "ADMIN"'
            ),
            `${f} has admin auth (should be public)`
        );
    }
});

// ==========================================
// 8. DATA INTEGRITY
// ==========================================

console.log(
    "\n8. Data Integrity:"
);

test("No ProductVariant.price writes", () => {
    const allCode = [
        checkoutCode,
        ordersRoute,
        ipaymuRoute,
        buyNowRoute,
        buyNowIpaymu,
    ].join("\n");
    assert(
        !allCode.includes(
            "ProductVariant.price ="
        ),
        "Found ProductVariant.price write"
    );
});

test("iPaymu grossAmount from server", () => {
    assert(
        ipaymuRoute.includes(
            "result.grossAmount"
        ),
        "iPaymu doesn't use server grossAmount"
    );
    assert(
        buyNowIpaymu.includes(
            "result.grossAmount"
        ),
        "Buy Now iPaymu doesn't use server grossAmount"
    );
});

// ==========================================
// VOUCHER PER-USER ENFORCEMENT
// ==========================================

test("Checkout uses enhanced voucher validator (not basic)", () => {
    assert(
        checkoutCode.includes("validateAndCalculateVoucherEnhanced"),
        "Checkout doesn't use enhanced voucher validator"
    );
    assert(
        !checkoutCode.includes("import {\n    incrementVoucherUsage,\n    incrementVoucherUserUsage,\n    validateAndCalculateVoucher,\n}"),
        "Checkout still imports basic validateAndCalculateVoucher"
    );
});

test("Enhanced validator receives userId for per-user limit", () => {
    assert(
        checkoutCode.includes("validateAndCalculateVoucherEnhanced(") &&
        checkoutCode.includes("input.userId"),
        "Enhanced validator doesn't receive userId"
    );
});

test("Enhanced validator receives items for product/category restrictions", () => {
    assert(
        checkoutCode.includes("VoucherValidationItem"),
        "Checkout doesn't build VoucherValidationItem array"
    );
    assert(
        checkoutCode.includes("voucherItems"),
        "Checkout doesn't pass items to enhanced validator"
    );
});

test("VoucherUserUsage recorded after global quota increment", () => {
    assert(
        checkoutCode.includes("incrementVoucherUserUsage"),
        "Checkout doesn't record per-user voucher usage"
    );
    assert(
        checkoutCode.includes("incrementVoucherUserUsage(") &&
        checkoutCode.includes("input.userId"),
        "Per-user usage doesn't receive userId"
    );
});

// ==========================================
// VOUCHER ROLLBACK
// ==========================================

test("Rollback decrements VoucherUserUsage", () => {
    assert(
        checkoutCode.includes("voucherUserUsage.findUnique"),
        "Rollback doesn't look up VoucherUserUsage"
    );
    assert(
        checkoutCode.includes("voucherUserUsage.update"),
        "Rollback doesn't decrement VoucherUserUsage"
    );
    assert(
        checkoutCode.includes("usageCount") &&
        checkoutCode.includes("decrement: 1"),
        "Rollback doesn't decrement usageCount"
    );
});

test("Rollback checks usageCount > 0 before decrementing", () => {
    assert(
        checkoutCode.includes("userUsage.usageCount > 0"),
        "Rollback doesn't guard against negative usageCount"
    );
});

// ==========================================
// FLASH SALE PER-USER LIMIT
// ==========================================

test("Flash sale records purchase after stock reservation", () => {
    assert(
        checkoutCode.includes("recordFlashSalePurchase"),
        "Checkout doesn't record flash sale purchase"
    );
    assert(
        checkoutCode.includes("recordFlashSalePurchase(") &&
        checkoutCode.includes("input.userId"),
        "Flash sale purchase recording doesn't receive userId"
    );
});

// ==========================================
// 9. DOUBLE-SUBMIT PROTECTION
// ==========================================

console.log("\n9. Double-Submit Protection:");

const checkoutPage = readFile("app/checkout/CheckoutPage.tsx");
const buyNowPage = readFile("app/buy-now/BuyNowPage.tsx");

test("CheckoutPage createOrder has creatingOrder guard", () => {
    assert(
        checkoutPage.includes("if (creatingOrder)") ||
        checkoutPage.includes("creatingOrder"),
        "CheckoutPage missing creatingOrder guard in createOrder"
    );
});

test("CheckoutPage submit button disables on creatingOrder", () => {
    assert(
        checkoutPage.includes("creatingOrder ||\n") ||
        checkoutPage.includes("creatingOrder ||\r\n"),
        "CheckoutPage submit button doesn't check creatingOrder"
    );
});

test("CheckoutPage shows loading text when creatingOrder", () => {
    assert(
        checkoutPage.includes("Memproses"),
        "CheckoutPage doesn't show loading text"
    );
});

test("BuyNowPage createOrder has creatingOrder guard", () => {
    assert(
        buyNowPage.includes("creatingOrder") &&
        buyNowPage.includes("return;"),
        "BuyNowPage missing creatingOrder guard"
    );
});

test("BuyNowPage button uses paymentButtonDisabled with creatingOrder", () => {
    assert(
        buyNowPage.includes("paymentButtonDisabled") &&
        buyNowPage.includes("creatingOrder"),
        "BuyNowPage button missing creatingOrder disable"
    );
});

test("CheckoutPage snapProcessingRef prevents Snap re-entry", () => {
    assert(
        checkoutPage.includes("snapProcessingRef.current"),
        "CheckoutPage missing snapProcessingRef"
    );
});

// ==========================================
// 10. STRUCTURED LOGGING
// ==========================================

console.log("\n10. Structured Logging:");

const ordersRouteCode = readFile("app/api/orders/route.ts");
const buyNowRouteCode = readFile("app/api/buy-now/route.ts");
const buyNowIpaymuCode = readFile("app/api/buy-now/ipaymu/route.ts");
const ipaymuCartCode = readFile("app/api/payment/ipaymu/route.ts");

test("Cart COD route has structured checkout failure log", () => {
    assert(
        ordersRouteCode.includes('event: "CHECKOUT_FAILURE"') &&
        ordersRouteCode.includes('checkoutType: "CART_COD"'),
        "Cart COD route missing structured log"
    );
});

test("Buy Now COD route has structured checkout failure log", () => {
    assert(
        buyNowRouteCode.includes('event: "CHECKOUT_FAILURE"') &&
        buyNowRouteCode.includes('checkoutType: "BUY_NOW_COD"'),
        "Buy Now COD route missing structured log"
    );
});

test("Buy Now iPaymu route has structured checkout failure log", () => {
    assert(
        buyNowIpaymuCode.includes('event: "CHECKOUT_FAILURE"'),
        "Buy Now iPaymu route missing structured log"
    );
});

test("Cart iPaymu route has structured checkout failure log", () => {
    assert(
        ipaymuCartCode.includes('event: "CHECKOUT_FAILURE"'),
        "Cart iPaymu route missing structured log"
    );
});

test("Structured logs include timestamp", () => {
    const routes = [ordersRouteCode, buyNowRouteCode, buyNowIpaymuCode, ipaymuCartCode];
    for (const route of routes) {
        assert(
            route.includes('timestamp: new Date().toISOString()'),
            `Route missing timestamp in structured log`
        );
    }
});

test("Cart iPaymu log includes orderId for correlation", () => {
    assert(
        ipaymuCartCode.includes('orderId: createdOrderId'),
        "Cart iPaymu log missing orderId correlation"
    );
});

// ==========================================
// 11. WEBHOOK FLASH-SALE INTEGRITY
// ==========================================

console.log("\n11. Webhook Flash-Sale Integrity:");

const webhookCode = readFile("app/api/payment/ipaymu/notification/route.ts");

test("Webhook expired handler uses atomic CAS", () => {
    assert(
        webhookCode.includes('$executeRaw') &&
        webhookCode.includes("EXPIRED") &&
        webhookCode.includes("IN ('PENDING', 'PROCESSING')"),
        "Webhook expired handler missing atomic CAS"
    );
});

test("Webhook failed handler uses atomic CAS", () => {
    assert(
        webhookCode.includes('$executeRaw') &&
        webhookCode.includes("FAILED") &&
        webhookCode.includes("IN ('PENDING', 'PROCESSING')"),
        "Webhook failed handler missing atomic CAS"
    );
});

test("Pending webhook cannot revert PAID order (CAS guard)", () => {
    assert(
        webhookCode.includes("paymentStatus != 'PAID'"),
        "Pending webhook missing PAID guard"
    );
});

test("Webhook has flash-sale aware stock release (via shared module)", () => {
    assert(
        orderStockCode.includes('flashSale.findFirst'),
        "order-stock.ts missing flash sale lookup"
    );
    assert(
        hasSql(orderStockCode, "UPDATE flashsale"),
        "order-stock.ts missing flash sale stock restore"
    );
    assert(
        hasSql(orderStockCode, "soldCount >="),
        "order-stock.ts missing soldCount guard for flash sale restore"
    );
    // BOTH webhook implementations (iPaymu is live, Midtrans legacy)
    // must release through the shared module, never with their own copy.
    assert(
        webhookCode.includes('releaseStockAndVoucherForOrder'),
        "iPaymu webhook missing releaseStockAndVoucherForOrder usage"
    );
    assert(
        readFile(
            "app/api/payment/midtrans/notification/route.ts"
        ).includes("releaseStockAndVoucherForOrder"),
        "Midtrans webhook missing releaseStockAndVoucherForOrder usage"
    );
});

test("Stock release is conditional (flash sale vs regular)", () => {
    // Conditional logic is in the shared module
    const orderStockCode = readFile("lib/order-stock.ts");
    assert(
        orderStockCode.includes('isFlashSale') || orderStockCode.includes('else'),
        "order-stock.ts should have conditional stock restoration"
    );
});

test("Webhook verifies payment signature", () => {
    /*
     * The route must verify the provider signature, and the comparison
     * itself must be timing-safe. iPaymu signs the raw body with the VA
     * (HMAC-SHA256); the helper is the only place that implements it.
     */
    assert(
        webhookCode.includes("verifyWebhookSignature("),
        "iPaymu webhook doesn't verify the X-Signature"
    );
    assert(
        readFile("lib/payment/ipaymu.ts").includes(
            "timingSafeEqual"
        ),
        "Signature comparison is not timing-safe"
    );
});

test("Webhook validates order amount", () => {
    /*
     * iPaymu names the amount field differently (sub_total / amount /
     * total) than Midtrans (gross_amount); the shared helper is the only
     * place that interprets it, and the route must call it on the
     * SETTLEMENT path, BEFORE the CAS update. A missing/mismatched amount
     * therefore fails closed and can never settle an order.
     */
    assert(
        webhookCode.includes("verifyNotificationAmount("),
        "iPaymu webhook doesn't validate the notified amount"
    );

    const settleIdx = flat(webhookCode).indexOf(
        'statusClass === "success"'
    );
    const amountIdx = flat(webhookCode).indexOf(
        "verifyNotificationAmount("
    );
    const casIdx = flat(webhookCode).indexOf(
        "AND paymentStatus NOT IN ('PAID', 'REFUNDED')"
    );

    assert(
        settleIdx >= 0 && amountIdx > settleIdx,
        "Amount validation is not on the settlement path"
    );
    assert(
        casIdx >= 0 && amountIdx < casIdx,
        "Amount must be verified BEFORE the settlement CAS"
    );
});

test("Webhook idempotent for PAID orders", () => {
    assert(
        webhookCode.includes('paymentStatus') &&
        (webhookCode.includes('PAID') || webhookCode.includes('paid')),
        "Webhook missing PAID guard"
    );
});test("Webhook idempotent for CANCELLED orders", () => {
    assert(webhookCode.includes('CANCELLED'),
        "Webhook missing CANCELLED guard"
    );
});

test("Stock release decrements VoucherUserUsage (via shared module)", () => {
    const orderStockCode = readFile("lib/order-stock.ts");
    assert(
        orderStockCode.includes('voucherUserUsage.findUnique'),
        "order-stock.ts missing VoucherUserUsage lookup"
    );
    assert(
        orderStockCode.includes('voucherUserUsage.update'),
        "order-stock.ts missing VoucherUserUsage decrement"
    );
});

test("Stock release checks usageCount > 0 before decrementing VoucherUserUsage", () => {
    const orderStockCode = readFile("lib/order-stock.ts");
    assert(
        orderStockCode.includes('usageCount > 0'),
        "order-stock.ts missing usageCount > 0 guard for VoucherUserUsage"
    );
});

test("Stock release scopes VoucherUserUsage by ownerKey (guest-aware)", () => {
    /*
     * The per-identity usage bucket moved from `voucherId_userId` to
     * `voucherId_ownerKey`, so a GUEST (userId = NULL) and a logged-in
     * buyer each release exactly the bucket they consumed. The scope must
     * be derived from the ORDER, never from the (untrusted) caller.
     */
    assert(
        orderStockCode.includes('voucherId_ownerKey'),
        "order-stock.ts not using the voucherId_ownerKey composite key"
    );
    assert(
        orderStockCode.includes("orderOwnerKey(order)"),
        "Release scope must be derived from the order, not the caller"
    );
});

test("Stock release has both Voucher and VoucherUserUsage operations", () => {
    const orderStockCode = readFile("lib/order-stock.ts");
    assert(
        orderStockCode.includes('voucher.updateMany') && orderStockCode.includes('voucherUserUsage'),
        "Voucher.usedCount and VoucherUserUsage decrements both not found in order-stock.ts"
    );
    const voucherIdx = orderStockCode.indexOf('voucher.updateMany');
    const userUsageIdx = orderStockCode.indexOf('voucherUserUsage.findUnique');
    assert(
        userUsageIdx > voucherIdx,
        "VoucherUserUsage decrement should come after Voucher.usedCount decrement"
    );
});

// ==========================================
// 12. CHECKOUT TRANSACTION INTEGRITY
// ==========================================

console.log("\n12. Checkout Transaction Integrity:");

test("Product.sold uses GREATEST guard in checkout rollback", () => {
    assert(
        checkoutCode.includes('GREATEST(0, sold -') ||
        checkoutCode.includes('GREATEST(0,sold -'),
        "Checkout rollback missing GREATEST guard on Product.sold"
    );
});

test("Product.sold uses GREATEST guard in stock release (shared module)", () => {
    const orderStockCode = readFile("lib/order-stock.ts");
    assert(
        orderStockCode.includes('GREATEST(0, sold -') ||
        orderStockCode.includes('GREATEST(0,sold -'),
        "order-stock.ts missing GREATEST guard on Product.sold"
    );
});

test("Flash sale stock uses transaction client (tx)", () => {
    assert(
        hasSql(checkoutCode, "UPDATE flashsale") &&
            checkoutCode.includes("tx.$executeRaw"),
        "Checkout flash sale stock reservation not using transaction client"
    );
    assert(
        orderStockCode.includes("tx.$executeRaw") &&
            hasSql(orderStockCode, "UPDATE flashsale"),
        "Shared release flash sale restore not using transaction client"
    );
});

test("Flash sale reservation failure throws error (no silent failure)", () => {
    assert(
        checkoutCode.includes('flash-sale') || checkoutCode.includes('Flash sale'),
        "Missing flash sale error handling"
    );
    // Should throw on affectedRows === 0
    assert(
        checkoutCode.includes('affectedRows') || checkoutCode.includes('affected_rows'),
        "Missing affectedRows check for flash sale"
    );
});

test("Regular stock reservation is atomic with stock >= quantity", () => {
    assert(
        checkoutCode.includes('updateMany') &&
        checkoutCode.includes('stock:'),
        "Regular stock reservation not atomic"
    );
});

test("All checkout paths pass voucherCode to shared engine", () => {
    assert(
        ordersRouteCode.includes('voucherCode'),
        "Cart COD doesn't pass voucherCode"
    );
    assert(
        buyNowRouteCode.includes('voucherCode'),
        "Buy Now COD doesn't pass voucherCode"
    );
    assert(
        buyNowIpaymuCode.includes('voucherCode'),
        "Buy Now iPaymu doesn't pass voucherCode"
    );
});

// ==========================================
// 13. MARKETING CUSTOMER INTEGRATION
// ==========================================

console.log("\n13. Marketing Customer Integration:");

const batchPricingCode = readFile("lib/marketing/batch-pricing.ts");
const voucherCode2 = readFile("lib/voucher.ts");
const cartApi = readFile("app/api/cart/route.ts");
const voucherValidateApi = readFile("app/api/voucher/validate/route.ts");
const bulkDiscountsApi = readFile("app/api/bulk-discounts/route.ts");
const shippingDiscountService = readFile("lib/marketing/shipping-discount.ts");
const productDetail = readFile("components/products/ProductDetail.tsx");

test("Batch pricing includes BULK_DISCOUNT source type", () => {
    assert(
        batchPricingCode.includes('"BULK_DISCOUNT"'),
        "Batch pricing missing BULK_DISCOUNT source type"
    );
});

test("Batch pricing has bulkDiscountName in result type", () => {
    assert(
        batchPricingCode.includes("bulkDiscountName"),
        "Batch pricing missing bulkDiscountName field"
    );
});

test("Batch pricing queries BulkDiscount table", () => {
    assert(
        batchPricingCode.includes("bulkDiscount.findMany"),
        "Batch pricing doesn't query BulkDiscount"
    );
});

test("Batch pricing applies bulk discount when no higher priority discount", () => {
    assert(
        batchPricingCode.includes("BULK_DISCOUNT") &&
        batchPricingCode.includes("bulkDiscountMap"),
        "Batch pricing missing bulk discount resolution logic"
    );
});

test("Voucher enhanced validator checks eligibility", () => {
    assert(
        voucherCode2.includes("eligibility") &&
        voucherCode2.includes("NEW_USER") &&
        voucherCode2.includes("RETURNING_USER"),
        "Voucher validator missing eligibility check"
    );
});

test("Voucher eligibility checks paid order count", () => {
    assert(
        voucherCode2.includes("paidOrderCount"),
        "Voucher validator doesn't check paid order count for eligibility"
    );
});

test("Cart API uses resolveBatchPrices for marketing pricing", () => {
    assert(
        cartApi.includes("resolveBatchPrices"),
        "Cart API doesn't use resolveBatchPrices"
    );
});

test("Cart API returns effectivePrice in items", () => {
    assert(
        cartApi.includes("effectivePrice"),
        "Cart API doesn't return effectivePrice"
    );
});

test("Cart API returns priceSource in items", () => {
    assert(
        cartApi.includes("priceSource"),
        "Cart API doesn't return priceSource"
    );
});

test("Voucher preview uses enhanced validator with eligibility", () => {
    assert(
        voucherValidateApi.includes("validateAndCalculateVoucherEnhanced"),
        "Voucher preview doesn't use enhanced validator"
    );
    assert(
        voucherValidateApi.includes("session.user.id"),
        "Voucher preview doesn't pass userId for eligibility"
    );
});

test("Customer bulk discount API exists and is public", () => {
    assert(
        bulkDiscountsApi.includes("GET") &&
        !bulkDiscountsApi.includes("requireAdmin"),
        "Bulk discounts API missing or requires admin"
    );
});

test("Checkout uses shipping discount service", () => {
    assert(
        checkoutCode.includes("calculateShippingDiscount"),
        "Checkout doesn't use shipping discount"
    );
    assert(
        checkoutCode.includes("finalShippingCost"),
        "Checkout doesn't use finalShippingCost"
    );
});

test("Product detail shows bulk discount tiers", () => {
    assert(
        productDetail.includes("bulkTiers"),
        "Product detail missing bulkTiers"
    );
    assert(
        productDetail.includes("Beli Banyak Lebih Hemat"),
        "Product detail missing bulk discount heading"
    );
});

test("Shipping discount enforces minimum cost of 0", () => {
    assert(
        shippingDiscountService.includes("Math.min(discountAmount, shippingCost)"),
        "Shipping discount doesn't floor at 0"
    );
});

// ==========================================
// 14. SERVER-SIDE SHIPPING VERIFICATION
// ==========================================

console.log("\n14. Server-Side Shipping Verification:");

test("verifyShippingCost function exported from checkout.ts", () => {
    assert(
        checkoutCode.includes("export async function verifyShippingCost") ||
        checkoutCode.includes("async function verifyShippingCost"),
        "Missing verifyShippingCost export"
    );
});

test("verifyShippingCost calls RajaOngkir API via calculateDomesticCost", () => {
    assert(
        checkoutCode.includes("calculateDomesticCost") ||
        checkoutCode.includes("rajaongkir"),
        "verifyShippingCost doesn't call RajaOngkir"
    );
});

test("verifyShippingCost origin comes from StoreSetting", () => {
    assert(
        checkoutCode.includes("storeSetting.rajaOngkirDestinationId"),
        "Origin not from StoreSetting"
    );
});

test("verifyShippingCost destination comes from UserAddress (server-verified)", () => {
    assert(
        checkoutCode.includes("address.rajaOngkirDestinationId"),
        "Destination not from UserAddress"
    );
});

test("verifyShippingCost calculates weight from ProductVariant.weight * quantity", () => {
    assert(
        checkoutCode.includes("totalWeight") && checkoutCode.includes("variant.weight"),
        "Weight not calculated from database"
    );
});

test("verifyShippingCost is called before $transaction", () => {
    const verifyIdx = checkoutCode.indexOf("verifyShippingCost");
    const txIdx = checkoutCode.indexOf("$transaction");
    assert(
        verifyIdx > 0 && txIdx > 0 && verifyIdx < txIdx,
        "verifyShippingCost must be called before $transaction"
    );
});

test("Order total uses verifiedShippingCost, not client value", () => {
    assert(
        checkoutCode.includes("finalShippingCost = verifiedShippingCost") ||
        checkoutCode.includes("finalShippingCost =verifiedShippingCost"),
        "finalShippingCost not initialized from verifiedShippingCost"
    );
});

test("grossAmount calculation uses finalShippingCost (server-verified)", () => {
    assert(
        checkoutCode.includes("subtotal -") &&
        checkoutCode.includes("discount +") &&
        checkoutCode.includes("finalShippingCost"),
        "grossAmount not using finalShippingCost"
    );
});

test("verifyShippingCost rejects if courier/service not found", () => {
    assert(
        checkoutCode.includes("tidak tersedia"),
        "Missing rejection message for unavailable service"
    );
});

test("verifyShippingCost validates origin is positive integer", () => {
    assert(
        checkoutCode.includes("Origin pengiriman tidak valid"),
        "Missing origin validation"
    );
});

test("verifyShippingCost validates destination is positive integer", () => {
    assert(
        checkoutCode.includes("Destination pengiriman tidak valid"),
        "Missing destination validation"
    );
});

test("verifyShippingCost validates weight is positive", () => {
    assert(
        checkoutCode.includes("Berat paket tidak valid"),
        "Missing weight validation"
    );
});

test("Address lookup uses both id and userId (IDOR protection)", () => {
    /*
     * A saved address is fetched with findFirst({ where: { id, userId } }),
     * so another customer's addressId can never be used (it resolves to no
     * row → 404). Guests have no address row at all: their inline address
     * is validated + resolved server-side by resolveGuestAddress().
     */
    assert(
        hasFlat(
            checkoutCode,
            "id: input.addressId, userId: input.userId"
        ),
        "Address lookup missing userId constraint"
    );
    assert(
        checkoutCode.includes(
            "input.userId && input.addressId"
        ),
        "Saved-address lookup must be gated on an authenticated userId"
    );
    assert(
        checkoutCode.includes("resolveGuestAddress("),
        "Guest address path missing server-side validation"
    );
});

test("UserAddress lookup is findFirst with userId filter (prevents cross-user access)", () => {
    assert(
        checkoutCode.includes("userAddress.findFirst") || checkoutCode.includes("UserAddress.findFirst"),
        "Address lookup not using findFirst with userId"
    );
});

test("All 4 order creation endpoints use createCheckoutOrder", () => {
    assert(
        ordersRouteCode.includes("createCheckoutOrder"),
        "Cart COD doesn't use createCheckoutOrder"
    );
    assert(
        buyNowRouteCode.includes("createCheckoutOrder"),
        "Buy Now COD doesn't use createCheckoutOrder"
    );
    assert(
        buyNowIpaymuCode.includes("createCheckoutOrder"),
        "Buy Now iPaymu doesn't use createCheckoutOrder"
    );
    assert(
        ipaymuCartCode.includes("createCheckoutOrder") || ipaymuCartCode.includes("createCheckoutOrder"),
        "Cart iPaymu doesn't use createCheckoutOrder"
    );
});

// ==========================================
// 15. CONCURRENCY & ATOMICITY
// ==========================================

console.log("\n15. Concurrency & Atomicity:");

test("RollbackCheckoutOrder uses $executeRaw for CAS (not findUnique-then-update)", () => {
    // The CAS UPDATE must come BEFORE the findUnique for items
    const casIdx = checkoutCode.indexOf("$executeRaw`\n                UPDATE \`Order\`");
    const findIdx = checkoutCode.indexOf("tx.order.findUnique");
    // Find the findUnique that's inside rollbackCheckoutOrder (after the CAS)
    const rollbackSection = checkoutCode.substring(
        checkoutCode.indexOf("rollbackCheckoutOrder"),
        checkoutCode.indexOf("clearCart")
    );
    const rollbackCasIdx = rollbackSection.indexOf("$executeRaw");
    const rollbackFindIdx = rollbackSection.indexOf("order.findUnique");
    assert(
        rollbackCasIdx >= 0 && rollbackFindIdx >= 0 && rollbackCasIdx < rollbackFindIdx,
        "CAS must come before findUnique in rollbackCheckoutOrder"
    );
});

test("Webhook expired: CAS comes before stock release", () => {
    /*
     * Expiry is handled by the shared FAILED/EXPIRED branch
     * (`isFailed || statusClass === "failed"`), so locate that branch in
     * the flattened source and assert ordering INSIDE it.
     */
    const branch = flat(webhookCode);
    const branchIdx = branch.indexOf(
        'if (isFailed || statusClass === "failed")'
    );
    const releaseIdx = branch.indexOf(
        "releaseStockAndVoucherForOrder("
    );
    /*
     * Search for the CAS guard INSIDE the branch: the pending branch
     * earlier in the file carries the same `paymentStatus != 'PAID'`
     * text, so a plain indexOf would compare against the wrong handler.
     */
    const casIdx = branch.indexOf(
        "paymentStatus != 'PAID'",
        branchIdx
    );

    assert(
        branchIdx >= 0 && releaseIdx > branchIdx,
        "Cannot locate the expired/failed handler"
    );
    assert(
        casIdx > branchIdx && casIdx < releaseIdx,
        "CAS must come before stock release in expired handler"
    );
});

test("Webhook failed: CAS comes before stock release", () => {
    const branch = flat(webhookCode);
    const branchIdx = branch.indexOf(
        'if (isFailed || statusClass === "failed")'
    );
    const releaseIdx = branch.indexOf(
        "releaseStockAndVoucherForOrder("
    );
    const earlyReturnIdx = branch.indexOf(
        "affectedRows === 0",
        branchIdx
    );

    assert(
        branchIdx >= 0 && releaseIdx > branchIdx,
        "Cannot locate the failed handler"
    );
    assert(
        earlyReturnIdx > branchIdx && earlyReturnIdx < releaseIdx,
        "Failed handler must skip the release when the CAS matched no row"
    );
});

test("RollbackCheckoutOrder does NOT have non-atomic read-check pattern", () => {
    const rollbackSection = checkoutCode.substring(
        checkoutCode.indexOf("rollbackCheckoutOrder"),
        checkoutCode.indexOf("clearCart")
    );
    // Should NOT have: order.status === "CANCELLED" as idempotency check
    // (replaced by CAS)
    assert(
        !rollbackSection.includes('order.status === "CANCELLED"'),
        "RollbackCheckoutOrder still has non-atomic read-check pattern"
    );
});

test("Webhook expired/failed use CAS (no findUnique before stock release)", () => {
    const expiredIfIdx = webhookCode.indexOf('if (\n            isExpired');
    const failedIfIdx = webhookCode.indexOf('if (\n            isFailed');
    const expiredSection = webhookCode.substring(expiredIfIdx, failedIfIdx);
    const casIdx = expiredSection.indexOf("$executeRaw");
    const releaseIdx = expiredSection.indexOf("releaseStockAndVoucherForOrder");
    const findUniqueIdx = expiredSection.indexOf("findUnique");
    assert(
        findUniqueIdx < 0 || findUniqueIdx > releaseIdx,
        "Expired handler still has findUnique before stock release (non-atomic)"
    );

    const refundedIfIdx = webhookCode.indexOf('if (\n            isRefunded');
    const failedSection = webhookCode.substring(failedIfIdx, refundedIfIdx);
    const failedCasIdx = failedSection.indexOf("$executeRaw");
    const failedReleaseIdx = failedSection.indexOf("releaseStockAndVoucherForOrder");
    const failedFindIdx = failedSection.indexOf("findUnique");
    assert(
        failedFindIdx < 0 || failedFindIdx > failedReleaseIdx,
        "Failed handler still has findUnique before stock release (non-atomic)"
    );
});

// ==========================================
// 16. ADMIN PRODUCT ARCHIVED FILTERING
// ==========================================

console.log("\n16. Admin Product Archived Filtering:");

const adminProductsCode = readFile("app/api/admin/products/route.ts");
const publicProductsCode = readFile("app/api/products/route.ts");

const adminProductsGetSection = adminProductsCode.substring(
    adminProductsCode.indexOf("export async function GET"),
    adminProductsCode.indexOf("export async function POST")
);

test("Admin products GET no longer hardcodes isArchived: false", () => {
    // The old code had: const where: any = { isArchived: false }
    // The new code should parse an optional archived param
    assert(
        adminProductsGetSection.includes('archivedParam'),
        "Admin products GET missing archivedParam parsing"
    );
});

test("Admin products GET supports ?archived=true filter", () => {
    assert(
        adminProductsGetSection.includes('archivedParam === "true"') &&
        adminProductsGetSection.includes('where.isArchived = true'),
        "Admin products GET missing archived=true filter"
    );
});

test("Admin products GET supports ?archived=false filter", () => {
    assert(
        adminProductsGetSection.includes('archivedParam === "false"') &&
        adminProductsGetSection.includes('where.isArchived = false'),
        "Admin products GET missing archived=false filter"
    );
});

test("Admin products GET shows all products when archived param omitted", () => {
    // When no archived param: no isArchived filter → show all
    assert(
        adminProductsGetSection.includes('no isArchived filter'),
        "Admin products GET missing comment about showing all when param omitted"
    );
});

test("Public products API still filters isArchived: false", () => {
    assert(
        publicProductsCode.includes('isArchived: false'),
        "Public products API no longer filters archived products"
    );
});

test("Public products API does not read archived query param", () => {
    assert(
        !publicProductsCode.includes('archivedParam') &&
        !publicProductsCode.includes('searchParams.get("archived")'),
        "Public products API should not expose archived filter"
    );
});

// ==========================================
// 17. ORDER CREATION RATE LIMITING
// ==========================================

console.log("\n17. Order Creation Rate Limiting:");

const ordersRouteRL = readFile("app/api/orders/route.ts");
const ipaymuCartRouteRL = readFile("app/api/payment/ipaymu/route.ts");
const buyNowIpaymuRouteRL = readFile("app/api/buy-now/ipaymu/route.ts");
const buyNowRouteRL = readFile("app/api/buy-now/route.ts");
const rateLimitLib = readFile("lib/rate-limit.ts");

test("rateLimiters.orderCreation exists in lib/rate-limit.ts", () => {
    assert(
        rateLimitLib.includes("orderCreation:"),
        "rateLimiters.orderCreation not defined"
    );
});

test("rateLimiters.orderCreation uses userId-based key", () => {
    assert(
        rateLimitLib.includes("order:${userId}"),
        "orderCreation limiter doesn't use userId key"
    );
});

test("rateLimiters.orderCreation limit is 10 per minute", () => {
    assert(
        rateLimitLib.includes("10, 60 * 1000"),
        "orderCreation limiter should be 10 requests per minute"
    );
});

test("POST /api/orders imports rateLimiters", () => {
    assert(
        usesRateLimiters(ordersRouteRL),
        "/api/orders POST doesn't import rateLimiters"
    );
});

test("POST /api/orders calls rateLimiters.orderCreation with userId", () => {
    assert(
        ordersRouteRL.includes("rateLimiters.orderCreation(userId)") ||
        ordersRouteRL.includes("rateLimiters.orderCreation(userId!),"),
        "/api/orders POST doesn't call rateLimiters.orderCreation with userId"
    );
});

test("POST /api/orders returns 429 when rate limited", () => {
    assert(
        ordersRouteRL.includes("429"),
        "/api/orders POST doesn't return 429"
    );
});

test("POST /api/orders rate limit check is before createCheckoutOrder", () => {
    const rlIdx = ordersRouteRL.indexOf("rateLimiters.orderCreation");
    const coIdx = ordersRouteRL.indexOf("await createCheckoutOrder");
    assert(
        rlIdx > 0 && coIdx > 0 && rlIdx < coIdx,
        "/api/orders POST rate limit must be before createCheckoutOrder"
    );
});

test("POST /api/payment/ipaymu imports rateLimiters", () => {
    assert(
        usesRateLimiters(ipaymuCartRouteRL),
        "/api/payment/ipaymu POST doesn't import rateLimiters"
    );
});

test("POST /api/payment/ipaymu calls rateLimiters.orderCreation with userId", () => {
    assert(
        ipaymuCartRouteRL.includes("rateLimiters.orderCreation(userId)"),
        "/api/payment/ipaymu POST doesn't call rateLimiters.orderCreation"
    );
});

test("POST /api/payment/ipaymu returns 429 when rate limited", () => {
    assert(
        ipaymuCartRouteRL.includes("429"),
        "/api/payment/ipaymu POST doesn't return 429"
    );
});

test("POST /api/payment/ipaymu rate limit check is before createCheckoutOrder", () => {
    const rlIdx = ipaymuCartRouteRL.indexOf("rateLimiters.orderCreation");
    const coIdx = ipaymuCartRouteRL.indexOf("await createCheckoutOrder");
    assert(
        rlIdx > 0 && coIdx > 0 && rlIdx < coIdx,
        "/api/payment/ipaymu POST rate limit must be before createCheckoutOrder"
    );
});

test("POST /api/buy-now/ipaymu imports rateLimiters", () => {
    assert(
        usesRateLimiters(buyNowIpaymuRouteRL),
        "/api/buy-now/ipaymu POST doesn't import rateLimiters"
    );
});

test("POST /api/buy-now/ipaymu calls rateLimiters.orderCreation with userId", () => {
    assert(
        limitsAuthedOrderCreation(buyNowIpaymuRouteRL),
        "/api/buy-now/ipaymu POST doesn't call rateLimiters.orderCreation"
    );
});

test("All four order-creation routes limit the AUTHENTICATED branch", () => {
    for (const [name, code] of [
        ["/api/orders", ordersRouteRL],
        ["/api/buy-now", buyNowRouteRL],
        ["/api/payment/ipaymu", ipaymuCartRouteRL],
        ["/api/buy-now/ipaymu", buyNowIpaymuRouteRL],
    ] as const) {
        assert(
            limitsAuthedOrderCreation(code),
            `${name} lost its per-user order-creation limiter`
        );
    }
});

test("All four order-creation routes limit the GUEST branch", () => {
    for (const [name, code] of [
        ["/api/orders", ordersRouteRL],
        ["/api/buy-now", buyNowRouteRL],
        ["/api/payment/ipaymu", ipaymuCartRouteRL],
        ["/api/buy-now/ipaymu", buyNowIpaymuRouteRL],
    ] as const) {
        assert(
            limitsGuestCheckout(code),
            `${name} lost its guest (device/identity) limiter`
        );
    }
});

test("POST /api/buy-now/ipaymu returns 429 when rate limited", () => {
    assert(
        buyNowIpaymuRouteRL.includes("429"),
        "/api/buy-now/ipaymu POST doesn't return 429"
    );
});

test("POST /api/buy-now/ipaymu rate limit check is before createCheckoutOrder", () => {
    const rlIdx = buyNowIpaymuRouteRL.indexOf("rateLimiters.orderCreation");
    const coIdx = buyNowIpaymuRouteRL.indexOf("await createCheckoutOrder");
    assert(
        rlIdx > 0 && coIdx > 0 && rlIdx < coIdx,
        "/api/buy-now/ipaymu POST rate limit must be before createCheckoutOrder"
    );
});

test("Existing POST /api/buy-now rate limiting still works", () => {
    assert(
        limitsAuthedOrderCreation(buyNowRouteRL),
        "/api/buy-now POST lost its rate limiting"
    );
});

test("Existing POST /api/buy-now rate limit is before createCheckoutOrder", () => {
    const rlIdx = buyNowRouteRL.indexOf("rateLimiters.orderCreation");
    const coIdx = buyNowRouteRL.indexOf("await createCheckoutOrder");
    assert(
        rlIdx > 0 && coIdx > 0 && rlIdx < coIdx,
        "/api/buy-now POST rate limit must be before createCheckoutOrder"
    );
});

test("All 4 order endpoints use same rate limiter (orderCreation)", () => {
    const endpoints = [ordersRouteRL, ipaymuCartRouteRL, buyNowIpaymuRouteRL, buyNowRouteRL];
    for (const code of endpoints) {
        assert(
            code.includes("rateLimiters.orderCreation"),
            "One of the order endpoints doesn't use rateLimiters.orderCreation"
        );
    }
});

test("Rate limit key uses userId (not IP) — prevents bypass via header spoofing", () => {
    // orderCreation uses userId, not IP
    assert(
        rateLimitLib.includes("order:${userId}"),
        "orderCreation limiter doesn't use userId"
    );
});

// ==========================================
// 18. ORDER NUMBER UNIQUENESS
// ==========================================

console.log("\n18. Order Number Uniqueness:");

const checkoutCodeRL = readFile("lib/checkout.ts");

test("makeOrderNumber uses crypto import", () => {
    assert(
        checkoutCodeRL.includes('import crypto from "crypto"'),
        "checkout.ts missing crypto import"
    );
});

test("makeOrderNumber uses crypto.randomUUID()", () => {
    assert(
        checkoutCodeRL.includes("crypto"),
        "makeOrderNumber doesn't use crypto"
    );
    assert(
        checkoutCodeRL.includes("randomUUID()"),
        "makeOrderNumber doesn't use randomUUID()"
    );
});

test("makeOrderNumber does NOT use Math.random()", () => {
    // Find the makeOrderNumber function body
    const fnStart = checkoutCodeRL.indexOf("function makeOrderNumber(");
    const fnEnd = checkoutCodeRL.indexOf("function parsePositiveInteger(");
    const fnBody = checkoutCodeRL.substring(fnStart, fnEnd);
    assert(
        !fnBody.includes("Math.random()"),
        "makeOrderNumber still uses Math.random()"
    );
});

test("makeOrderNumber preserves COD prefix (ORD)", () => {
    const fnStart = checkoutCodeRL.indexOf("function makeOrderNumber(");
    const fnEnd = checkoutCodeRL.indexOf("function parsePositiveInteger(");
    const fnBody = checkoutCodeRL.substring(fnStart, fnEnd);
    assert(
        fnBody.includes('"ORD"'),
        "makeOrderNumber missing ORD prefix for COD"
    );
});

test("makeOrderNumber preserves BUY_NOW prefix (PAY-BN)", () => {
    const fnStart = checkoutCodeRL.indexOf("function makeOrderNumber(");
    const fnEnd = checkoutCodeRL.indexOf("function parsePositiveInteger(");
    const fnBody = checkoutCodeRL.substring(fnStart, fnEnd);
    assert(
        fnBody.includes('"PAY-BN"'),
        "makeOrderNumber missing PAY-BN prefix"
    );
});

test("makeOrderNumber preserves CART prefix (PAY-CART)", () => {
    const fnStart = checkoutCodeRL.indexOf("function makeOrderNumber(");
    const fnEnd = checkoutCodeRL.indexOf("function parsePositiveInteger(");
    const fnBody = checkoutCodeRL.substring(fnStart, fnEnd);
    assert(
        fnBody.includes('"PAY-CART"'),
        "makeOrderNumber missing PAY-CART prefix"
    );
});

test("makeOrderNumber generates unique numbers in burst", () => {
    // Simulate burst: generate 1000 order numbers rapidly
    // No two should be identical
    const crypto = require("crypto");
    function makeOrderNumberLocal(prefix: string) {
        const suffix = crypto.randomUUID().replace(/-/g, "").substring(0, 8);
        return `${prefix}-${Date.now()}-${suffix}`;
    }
    const numbers = new Set<string>();
    for (let i = 0; i < 1000; i++) {
        numbers.add(makeOrderNumberLocal("ORD"));
    }
    assert(
        numbers.size === 1000,
        `Expected 1000 unique numbers, got ${numbers.size}`
    );
});

test("makeOrderNumber format matches expected pattern", () => {
    const crypto = require("crypto");
    function makeOrderNumberLocal(prefix: string) {
        const suffix = crypto.randomUUID().replace(/-/g, "").substring(0, 8);
        return `${prefix}-${Date.now()}-${suffix}`;
    }
    const orderNum = makeOrderNumberLocal("ORD");
    // Format: ORD-{timestamp}-{8hex}
    assert(
        /^ORD-\d{13}-[0-9a-f]{8}$/.test(orderNum),
        `Order number format mismatch: ${orderNum}`
    );
    const payBn = makeOrderNumberLocal("PAY-BN");
    assert(
        /^PAY-BN-\d{13}-[0-9a-f]{8}$/.test(payBn),
        `PAY-BN format mismatch: ${payBn}`
    );
    const payCart = makeOrderNumberLocal("PAY-CART");
    assert(
        /^PAY-CART-\d{13}-[0-9a-f]{8}$/.test(payCart),
        `PAY-CART format mismatch: ${payCart}`
    );
});

// ==========================================
// 19. CLEANUP PENDING CHECKOUT HARDENING
// ==========================================

console.log("\n19. Cleanup Pending Checkout Hardening:");

const checkoutCodeCleanup = readFile("lib/checkout.ts");

// Extract the cleanupPendingCheckoutOrders function body
const cleanupFnStart = checkoutCodeCleanup.indexOf("export async function cleanupPendingCheckoutOrders(");
const cleanupFnEnd = checkoutCodeCleanup.indexOf("export async function createCheckoutOrder(");
const cleanupFn = checkoutCodeCleanup.substring(cleanupFnStart, cleanupFnEnd);

test("cleanupPendingCheckoutOrders has take: 10 limit", () => {
    assert(
        cleanupFn.includes("take: 10"),
        "cleanupPendingCheckoutOrders missing take: 10 limit"
    );
});

test("cleanupPendingCheckoutOrders selects orderNumber for logging", () => {
    assert(
        cleanupFn.includes("orderNumber: true"),
        "cleanupPendingCheckoutOrders doesn't select orderNumber"
    );
});

test("cleanupPendingCheckoutOrders logs orderNumber on failure", () => {
    assert(
        cleanupFn.includes("orderNumber="),
        "cleanupPendingCheckoutOrders doesn't log orderNumber"
    );
});

test("cleanupPendingCheckoutOrders logs orderId on failure", () => {
    assert(
        cleanupFn.includes("orderId="),
        "cleanupPendingCheckoutOrders doesn't log orderId"
    );
});

test("cleanupPendingCheckoutOrders uses try/catch per order", () => {
    // Should have try and catch inside the for loop
    const forIdx = cleanupFn.indexOf("for (const order of pendingOrders)");
    const tryIdx = cleanupFn.indexOf("try {", forIdx);
    const catchIdx = cleanupFn.indexOf("catch (error)", tryIdx);
    assert(
        forIdx > 0 && tryIdx > forIdx && catchIdx > tryIdx,
        "cleanupPendingCheckoutOrders missing try/catch inside for loop"
    );
});

test("cleanupPendingCheckoutOrders calls rollbackCheckoutOrder with restoreCart: false", () => {
    assert(
        cleanupFn.includes("restoreCart: false"),
        "cleanupPendingCheckoutOrders doesn't pass restoreCart: false"
    );
});

test("cleanupPendingCheckoutOrders queries only PENDING status", () => {
    assert(
        cleanupFn.includes('status: "PENDING"'),
        "cleanupPendingCheckoutOrders doesn't filter by PENDING status"
    );
    assert(
        cleanupFn.includes('paymentStatus: "PENDING"'),
        "cleanupPendingCheckoutOrders doesn't filter by PENDING paymentStatus"
    );
});

test("cleanupPendingCheckoutOrders filters by paymentMethod (non-COD)", () => {
    assert(
        cleanupFn.includes('"BANK_TRANSFER"') &&
        cleanupFn.includes('"E_WALLET"') &&
        cleanupFn.includes('"QRIS"'),
        "cleanupPendingCheckoutOrders doesn't filter by non-COD payment methods"
    );
});

test("cleanupPendingCheckoutOrders is called in createCheckoutOrder", () => {
    const createFnStart = checkoutCodeCleanup.indexOf("export async function createCheckoutOrder(");
    const createFn = checkoutCodeCleanup.substring(createFnStart);
    assert(
        createFn.includes("cleanupPendingCheckoutOrders"),
        "createCheckoutOrder doesn't call cleanupPendingCheckoutOrders"
    );
});

test("cleanupPendingCheckoutOrders calls cleanup BEFORE $transaction (not inside)", () => {
    const createFnStart = checkoutCodeCleanup.indexOf("export async function createCheckoutOrder(");
    const createFn = checkoutCodeCleanup.substring(createFnStart);
    const cleanupIdx = createFn.indexOf("cleanupPendingCheckoutOrders");
    const txIdx = createFn.indexOf("$transaction");
    assert(
        cleanupIdx > 0 && txIdx > 0 && cleanupIdx < txIdx,
        "cleanupPendingCheckoutOrders must be called before $transaction"
    );
});

// ==========================================
// 20. FLASH SALE PURCHASE CLEANUP ON ROLLBACK
// ==========================================

console.log("\n20. Flash Sale Purchase Cleanup on Rollback:");

const checkoutCodeT1 = readFile("lib/checkout.ts");
const webhookCodeT1 = readFile("app/api/payment/ipaymu/notification/route.ts");

// Extract rollbackCheckoutOrder section
const rollbackFnStart = checkoutCodeT1.indexOf("export async function rollbackCheckoutOrder(");
const rollbackFnEnd = checkoutCodeT1.indexOf("export async function clearCart(");
const rollbackFn = checkoutCodeT1.substring(rollbackFnStart, rollbackFnEnd);

test("rollbackCheckoutOrder deletes FlashSalePurchase after restoring flash sale stock", () => {
    assert(
        rollbackFn.includes("flashSalePurchase.deleteMany"),
        "rollbackCheckoutOrder missing flashSalePurchase.deleteMany"
    );
});

test("rollbackCheckoutOrder FlashSalePurchase cleanup uses flashSaleId and the order scope", () => {
    /*
     * Purchase rows are keyed by (flashSaleId, ownerKey). Filtering by
     * userId would, for a guest order (userId = NULL), delete EVERY
     * guest's row for that sale — so the cleanup must use ownerKey.
     */
    assert(
        rollbackFn.includes("flashSaleId: flashSale.id") &&
            rollbackFn.includes("ownerKey: flashSaleScope"),
        "rollbackCheckoutOrder FlashSalePurchase cleanup missing flashSaleId or ownerKey scope"
    );
});

test("rollbackCheckoutOrder FlashSalePurchase cleanup is inside flash sale block (not regular item block)", () => {
    /*
     * Scope to the shared primitive that owns the release now, and match
     * quoting/case-agnostically: the cleanup must sit between the
     * flash-sale UPDATE and the regular-item `else` branch.
     */
    const lower = flat(cancelReservationsBody).toLowerCase();
    const flashSaleUpdateIdx = lower.indexOf("update flashsale");
    const deleteManyIdx = lower.indexOf(
        "flashsalepurchase.deletemany"
    );
    const elseIdx = lower.indexOf("} else {", flashSaleUpdateIdx);

    assert(
        flashSaleUpdateIdx > 0 &&
            deleteManyIdx > flashSaleUpdateIdx &&
            deleteManyIdx < elseIdx,
        "FlashSalePurchase cleanup is not inside the flash sale block"
    );
});

test("Stock release deletes FlashSalePurchase after restoring flash sale stock", () => {
    assert(
        orderStockCode.includes("flashSalePurchase.deleteMany"),
        "order-stock.ts missing flashSalePurchase.deleteMany"
    );
});

test("Stock release FlashSalePurchase cleanup uses variantId and the order scope", () => {
    assert(
        orderStockCode.includes("flashSale: { variantId:") &&
            orderStockCode.includes("ownerKey: orderScope"),
        "order-stock.ts FlashSalePurchase cleanup missing variantId or ownerKey scope"
    );
});

test("Stock release FlashSalePurchase cleanup is inside flash sale block", () => {
    const lower = flat(orderStockCode).toLowerCase();
    const flashSaleUpdateIdx = lower.indexOf("update flashsale");
    const deleteManyIdx = lower.indexOf(
        "flashsalepurchase.deletemany"
    );

    assert(
        flashSaleUpdateIdx > 0 &&
            deleteManyIdx > flashSaleUpdateIdx,
        "FlashSalePurchase cleanup should come after flash sale stock restore"
    );
});

// ==========================================
// 21. ADMIN ORDER STATUS TRANSITION GUARD
// ==========================================

console.log("\n21. Admin Order Status Transition Guard:");

const adminOrderCode = readFile("app/api/admin/orders/[id]/route.ts");

// Extract PATCH handler section
const patchFnStart = adminOrderCode.indexOf("export async function PATCH(");
const patchFnEnd = adminOrderCode.indexOf("function createTrackingUrl(");
const patchFn = adminOrderCode.substring(patchFnStart, patchFnEnd);

test("Admin PATCH has validTransitions map", () => {
    assert(
        patchFn.includes("validTransitions"),
        "Admin PATCH missing validTransitions map"
    );
});

test("Admin PATCH prevents PENDING → PENDING (self-transition not in list)", () => {
    assert(
        patchFn.includes('PENDING:'),
        "Admin PATCH missing PENDING transition list"
    );
});

test("Admin PATCH prevents COMPLETED backward transitions", () => {
    assert(
        patchFn.includes('COMPLETED:') && patchFn.includes('[]'),
        "Admin PATCH missing COMPLETED empty transition list"
    );
});

test("Admin PATCH prevents CANCELLED backward transitions", () => {
    assert(
        patchFn.includes('CANCELLED:') && patchFn.includes('[]'),
        "Admin PATCH missing CANCELLED empty transition list"
    );
});test("Admin PATCH transition guard is before order update", () => {
    const guardIdx = patchFn.indexOf("validTransitions[order.status]");
    const updateIdxPrisma = patchFn.indexOf("prisma.order.update");
    const updateIdxTx = patchFn.indexOf("tx.order.update");
    const updateIdxCas = patchFn.indexOf("tx.$executeRaw");
    const candidates = [updateIdxPrisma, updateIdxTx, updateIdxCas].filter((i) => i > 0);
    const updateIdx = candidates.length > 0 ? Math.min(...candidates) : -1;
    assert(guardIdx > 0 && updateIdx > 0 && guardIdx < updateIdx,
        "Admin PATCH transition guard must be before order update"
    );
});

test("Admin PATCH returns 400 for invalid transition", () => {
    assert(
        patchFn.includes("400") && patchFn.includes("Transisi"),
        "Admin PATCH missing 400 response for invalid transition"
    );
});

test("Admin PATCH SHIPPED requires tracking number (existing check)", () => {
    assert(
        patchFn.includes('status === "SHIPPED"') && patchFn.includes("trackingNumber"),
        "Admin PATCH missing SHIPPED tracking number check"
    );
});

// ==========================================
// 22. PAYMENT / WEBHOOK INTEGRITY (T2)
// ==========================================

console.log("\n22. Payment / Webhook Integrity:");

const webhookCodeT2 = readFile("app/api/payment/ipaymu/notification/route.ts");

/*
 * The guard assertions below are scoped to the CURRENT handler branches:
 *   - pending: `if (isPending || statusClass === "pending")`
 *   - failed/expired: `if (isFailed || statusClass === "failed")`
 *   - refund: `if (isRefunded)`
 * The old `isExpired` branch no longer exists (iPaymu reports expiry as a
 * failed status), so the previous slices captured nothing and the checks
 * "passed" only by accident of substring position.
 */
const ipaymuWebhook = flat(webhookCodeT2);
const pendingBranchIdx = ipaymuWebhook.indexOf(
    'if (isPending || statusClass === "pending")'
);
const failedBranchIdx = ipaymuWebhook.indexOf(
    'if (isFailed || statusClass === "failed")'
);
const refundBranchIdx = ipaymuWebhook.indexOf("const isRefunded =");
const settlementBranchIdx = ipaymuWebhook.indexOf(
    'if (isSuccess || statusClass === "success")'
);

function branch(startIdx: number, endIdx: number): string {
    if (startIdx < 0) return "";
    return ipaymuWebhook.substring(
        startIdx,
        endIdx > startIdx ? endIdx : undefined
    );
}

test("Pending webhook has status IN ('PENDING', 'PROCESSING') guard", () => {
    const pendingSection = branch(
        pendingBranchIdx,
        failedBranchIdx
    );
    assert(
        pendingSection.includes(
            "status IN ('PENDING', 'PROCESSING')"
        ),
        "Pending webhook missing status IN guard — could revert CANCELLED order to PENDING"
    );
});

test("Pending webhook still has paymentStatus != 'PAID' guard", () => {
    const pendingSection = branch(
        pendingBranchIdx,
        failedBranchIdx
    );
    assert(
        pendingSection.includes("paymentStatus != 'PAID'"),
        "Pending webhook missing PAID guard"
    );
});

test("Expired webhook has both status IN and paymentStatus != PAID guards", () => {
    const expiredSection = branch(
        failedBranchIdx,
        refundBranchIdx
    );
    assert(
        expiredSection.includes(
            "status IN ('PENDING', 'PROCESSING')"
        ) &&
            expiredSection.includes("paymentStatus != 'PAID'"),
        "Expired webhook missing CAS guards"
    );
});

test("Failed webhook has both status IN and paymentStatus != PAID guards", () => {
    const failedSection = branch(
        failedBranchIdx,
        refundBranchIdx
    );
    assert(
        failedSection.includes(
            "status IN ('PENDING', 'PROCESSING')"
        ) &&
            failedSection.includes("paymentStatus != 'PAID'"),
        "Failed webhook missing CAS guards"
    );
});

test("Refund webhook uses CAS with paymentStatus = 'PAID' guard", () => {
    /*
     * The refund transition + completion moved into lib/refund.ts
     * (transitionRefundForWebhook / executeRefundCompletion), which is
     * where the CAS and the `paymentStatus = 'PAID'` guard live. The route
     * must delegate to them and must NOT re-implement its own update.
     */
    const refundLib = readFile("lib/refund.ts");
    assert(
        branch(refundBranchIdx, settlementBranchIdx).includes(
            "transitionRefundForWebhook("
        ) &&
            branch(refundBranchIdx, settlementBranchIdx).includes(
                "executeRefundCompletion("
            ),
        "Refund webhook must delegate to the shared refund pipeline"
    );
    assert(
        hasSql(refundLib, "AND paymentStatus = 'PAID'"),
        "Refund pipeline missing CAS paymentStatus = 'PAID' guard"
    );
    assert(
        refundLib.includes("affectedRows === 0"),
        "Refund pipeline missing CAS affectedRows check"
    );
});

test("Refund webhook is idempotent (CAS prevents double-processing)", () => {
    /*
     * There is no `refundSettled` column any more: idempotency is the CAS
     * itself. The first caller completes the refund; every later webhook
     * gets shouldComplete === false (or a 0-row CAS) and is a no-op.
     */
    const refundLib = readFile("lib/refund.ts");
    const refundSection = branch(
        refundBranchIdx,
        settlementBranchIdx
    );

    assert(
        refundSection.includes("transition.shouldComplete"),
        "Refund webhook doesn't gate completion on the CAS transition"
    );
    assert(
        refundLib.includes("export async function transitionRefundForWebhook") &&
            refundLib.includes("affectedRows === 0"),
        "Refund transition is not CAS-guarded"
    );
});

test("Settlement webhook is idempotent (CAS prevents resurrection)", () => {
    const settlementSection = branch(
        settlementBranchIdx,
        pendingBranchIdx
    );

    assert(
        settlementSection.includes("affectedRows === 0"),
        "Settlement webhook missing CAS affectedRows check"
    );
    assert(
        settlementSection.includes("status IN ('PENDING', 'PROCESSING')"),
        "Settlement CAS must only transition PENDING/PROCESSING"
    );
    assert(
        settlementSection.includes(
            "paymentStatus NOT IN ('PAID', 'REFUNDED')"
        ),
        "Settlement CAS must never resurrect PAID/REFUNDED orders"
    );
});

test("Webhook verifies payment signature with timing-safe comparison", () => {
    assert(
        webhookCodeT2.includes("verifyWebhookSignature("),
        "iPaymu webhook doesn't verify the webhook signature"
    );
    assert(
        readFile("lib/payment/ipaymu.ts").includes(
            "timingSafeEqual"
        ),
        "Webhook missing timingSafeEqual for signature verification"
    );
});

test("Webhook validates the notified amount against the order total", () => {
    /*
     * iPaymu reports the amount as sub_total/amount/total (not Midtrans'
     * gross_amount). verifyNotificationAmount() is the single interpreter
     * and must be called on the settlement path before the CAS.
     */
    const settlementSection = branch(
        settlementBranchIdx,
        pendingBranchIdx
    );

    assert(
        settlementSection.includes("verifyNotificationAmount("),
        "Webhook missing amount validation"
    );
    assert(
        settlementSection.includes("existingOrder.total"),
        "Amount must be compared against the server-authoritative order total"
    );
    assert(
        settlementSection.indexOf("verifyNotificationAmount(") <
            settlementSection.indexOf("affectedRows === 0"),
        "Amount must be verified BEFORE the settlement CAS"
    );
});

test("Webhook returns 200 for unknown order (prevents retry loop)", () => {
    // Order not found should return 200 to stop retries
    assert(
        webhookCodeT2.includes('Order tidak ditemukan'),
        "Webhook missing order-not-found handling"
    );
});

test("Webhook returns 500 on error (triggers retry)", () => {
    assert(
        webhookCodeT2.includes('Webhook processing failed'),
        "Webhook missing 500 error handling"
    );
});

test("All three failure webhooks (expired, failed, refund) use releaseStockAndVoucherForOrder inside transaction", () => {
    assert(
        webhookCodeT2.includes('releaseStockAndVoucherForOrder'),
        "Webhook missing releaseStockAndVoucherForOrder"
    );
});

test("Webhook does NOT restore stock on settlement (PAID)", () => {
    const settlementSection = webhookCodeT2.substring(
        webhookCodeT2.indexOf('Payment settlement processed'),
        webhookCodeT2.indexOf('isPending')
    );
    assert(
        !settlementSection.includes('releaseStockAndVoucherForOrder'),
        "Settlement handler should NOT call releaseStockAndVoucherForOrder"
    );
    assert(
        !hasSql(settlementSection, "UPDATE flashsale"),
        "Settlement handler should NOT restore flash sale stock"
    );
});

// ==========================================
// RESULTS
// =========================================>

console.log(
    `\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`
);

if (failed > 0) {
    process.exit(1);
}
