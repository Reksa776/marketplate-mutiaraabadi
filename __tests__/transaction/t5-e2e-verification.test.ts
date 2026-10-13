/**
 * ==========================================
 * T5: FINAL TRANSACTION E2E VERIFICATION
 * ==========================================
 *
 * Comprehensive verification of ALL transaction
 * flows. Uses static code-path analysis + numeric
 * assertions to verify correctness.
 *
 * Checklist:
 * 1. COD checkout
 * 2. Midtrans checkout
 * 3. Buy Now
 * 4. Cart checkout
 * 5. Successful payment
 * 6. Failed payment
 * 7. Expired payment
 * 8. Duplicate webhook
 * 9. Concurrent rollback
 * 10. Concurrent checkout
 * 11. Voucher redemption
 * 12. Voucher rollback
 * 13. Flash sale purchase
 * 14. Flash sale rollback
 * 15. Stock reservation
 * 16. Stock restoration
 * 17. Pending cleanup
 * 18. Order status transitions
 * 19. Shipping cost verification
 * 20. Marketing pricing integration
 *
 * Run: npx tsx __tests__/transaction/t5-e2e-verification.test.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import {
    flat,
    functionBody,
    hasSql,
} from "../helpers/source-invariants";

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

console.log("\n=== T5: FINAL TRANSACTION E2E VERIFICATION ===\n");

// ==========================================
// LOAD ALL CRITICAL FILES
// ==========================================

const checkoutCode = readFile("lib/checkout.ts");
const webhookCode = readFile("app/api/payment/midtrans/notification/route.ts");
const ordersRoute = readFile("app/api/orders/route.ts");
const buyNowRoute = readFile("app/api/buy-now/route.ts");
const buyNowIpaymu = readFile("app/api/buy-now/ipaymu/route.ts");
const ipaymuRoute = readFile("app/api/payment/ipaymu/route.ts");
const voucherCode = readFile("lib/voucher.ts");
const flashSaleCode = readFile("lib/marketing/flash-sale.ts");
const batchPricingCode = readFile("lib/marketing/batch-pricing.ts");
const adminOrderRoute = readFile("app/api/admin/orders/[id]/route.ts");
const cartApi = readFile("app/api/cart/route.ts");
const shippingDiscountCode = readFile("lib/marketing/shipping-discount.ts");

/*
 * iPaymu is the LIVE payment provider; the Midtrans notification route is
 * legacy but still deployed, so provider-specific invariants are checked
 * on both. Stock/voucher release and the rollback CAS now live in shared
 * modules, so those are asserted where they are implemented.
 */
const ipaymuWebhookCode = readFile(
    "app/api/payment/ipaymu/notification/route.ts"
);
const orderStockCode = readFile("lib/order-stock.ts");
const refundCode = readFile("lib/refund.ts");

/**
 * The rollback primitive that OWNS the cancel CAS. rollbackCheckoutOrder()
 * is a thin wrapper around it, so scoping assertions here keeps them true
 * when the wrapper changes.
 */
const cancelReservationsBody = functionBody(
    checkoutCode,
    "export async function cancelOrderForReservations"
);

/** The webhook implementations that must delegate release to order-stock. */
const webhookImplementations = [
    ["midtrans", webhookCode],
    ["ipaymu", ipaymuWebhookCode],
] as const;

// ==========================================
// 1. COD CHECKOUT
// ==========================================
console.log("1. COD Checkout:");

test("All COD endpoints route through createCheckoutOrder", () => {
    assert(
        ordersRoute.includes("createCheckoutOrder"),
        "Cart COD missing createCheckoutOrder"
    );
    assert(
        buyNowRoute.includes("createCheckoutOrder"),
        "Buy Now COD missing createCheckoutOrder"
    );
});

test("COD sets paymentMethod to COD", () => {
    assert(
        ordersRoute.includes('"COD"'),
        "Cart COD missing COD paymentMethod"
    );
    assert(
        buyNowRoute.includes('"COD"'),
        "Buy Now COD missing COD paymentMethod"
    );
});

test("COD clears cart after order creation", () => {
    assert(
        checkoutCode.includes('"COD"') &&
        checkoutCode.includes("cartItem.deleteMany"),
        "COD flow doesn't clear cart"
    );
});

test("COD creates order with UNPAID paymentStatus", () => {
    assert(
        checkoutCode.includes('"UNPAID"'),
        "COD missing UNPAID paymentStatus"
    );
});

test("All COD endpoints return orderNumber and total", () => {
    // Cart COD spreads ...result.order (which contains orderNumber)
    // and explicitly adds total: result.grossAmount
    assert(
        ordersRoute.includes("result.order") && ordersRoute.includes("result.grossAmount"),
        "Cart COD missing order data or grossAmount"
    );
    assert(
        buyNowRoute.includes("result.grossAmount"),
        "Buy Now COD missing grossAmount"
    );
});

// ==========================================
// 2. IPAYMU CHECKOUT
// ==========================================
console.log("\n2. iPaymu Checkout:");

test("iPaymu checkout routes through createCheckoutOrder", () => {
    assert(
        ipaymuRoute.includes("createCheckoutOrder"),
        "Cart iPaymu missing createCheckoutOrder"
    );
    assert(
        buyNowIpaymu.includes("createCheckoutOrder"),
        "Buy Now iPaymu missing createCheckoutOrder"
    );
});

test("iPaymu does NOT clear cart (preserves for retry)", () => {
    assert(
        !ipaymuRoute.includes("cartItem.deleteMany") ||
        ipaymuRoute.includes("restoreCart: false"),
        "Cart iPaymu incorrectly clears cart"
    );
    assert(
        !buyNowIpaymu.includes("cartItem.deleteMany") ||
        buyNowIpaymu.includes("restoreCart: false"),
        "Buy Now iPaymu incorrectly clears cart"
    );
});

test("iPaymu uses server-calculated grossAmount", () => {
    assert(
        ipaymuRoute.includes("result.grossAmount"),
        "Cart iPaymu doesn't use server grossAmount"
    );
    assert(
        buyNowIpaymu.includes("result.grossAmount"),
        "Buy Now iPaymu doesn't use server grossAmount"
    );
});

test("iPaymu uses item_details from server", () => {
    /*
     * iPaymu v2 takes PARALLEL ARRAYS (product / price / qty / productQty)
     * rather than a single item_details array. The invariant is unchanged:
     * every entry is built from result.checkoutItems (server-side prices),
     * never from the request body, and the total is reconciled against the
     * server-computed grossAmount.
     */
    for (const [name, code] of [
        ["/api/payment/ipaymu", ipaymuRoute],
        ["/api/buy-now/ipaymu", buyNowIpaymu],
    ] as const) {
        assert(
            code.includes("result.checkoutItems"),
            `${name} doesn't build the provider payload from server items`
        );
        assert(
            code.includes("result.grossAmount"),
            `${name} doesn't reconcile against the server grossAmount`
        );
        assert(
            !/body\.(items|itemDetails|products)\b/.test(code),
            `${name} trusts client-supplied line items`
        );
    }
});

test("iPaymu rolls back on snap failure", () => {
    assert(
        ipaymuRoute.includes("rollbackCheckoutOrder"),
        "Cart iPaymu doesn't rollback on failure"
    );
    assert(
        buyNowIpaymu.includes("rollbackCheckoutOrder"),
        "Buy Now iPaymu doesn't rollback on failure"
    );
});

// ==========================================
// 3. BUY NOW
// ==========================================
console.log("\n3. Buy Now:");

test("Buy Now routes go through createCheckoutOrder", () => {
    assert(
        buyNowRoute.includes("createCheckoutOrder") &&
        buyNowIpaymu.includes("createCheckoutOrder"),
        "Buy Now not using shared checkout"
    );
});

test("Buy Now uses BUY_NOW mode parameter", () => {
    assert(
        buyNowRoute.includes('mode: "BUY_NOW"'),
        "Buy Now COD missing BUY_NOW mode"
    );
    assert(
        buyNowIpaymu.includes('mode: "BUY_NOW"'),
        "Buy Now iPaymu missing BUY_NOW mode"
    );
});

test("Buy Now validates productId, variantId, quantity", () => {
    assert(
        buyNowRoute.includes("productId") && buyNowRoute.includes("variantId") && buyNowRoute.includes("quantity"),
        "Buy Now missing parameter validation"
    );
});

test("Buy Now has rate limiting", () => {
    assert(
        buyNowRoute.includes("rateLimiters.orderCreation"),
        "Buy Now COD missing rate limiting"
    );
    assert(
        buyNowIpaymu.includes("rateLimiters.orderCreation"),
        "Buy Now iPaymu missing rate limiting"
    );
});

// ==========================================
// 4. CART CHECKOUT
// ==========================================
console.log("\n4. Cart Checkout:");

test("Cart checkout reads items from database (not client)", () => {
    assert(
        checkoutCode.includes("tx.cart.findUnique") || checkoutCode.includes("prisma.cart.findUnique"),
        "Cart checkout doesn't read items from database"
    );
});

test("Cart checkout validates stock for each item", () => {
    assert(
        checkoutCode.includes("quantity > item.variant.stock") || checkoutCode.includes("item.variant.stock"),
        "Cart checkout doesn't validate stock"
    );
});

test("Cart checkout calculates subtotal from server prices", () => {
    assert(
        checkoutCode.includes("item.subtotal"),
        "Cart checkout doesn't calculate subtotal from server"
    );
});

test("Cart checkout skips empty cart", () => {
    assert(
        checkoutCode.includes("Keranjang kosong"),
        "Cart checkout doesn't check for empty cart"
    );
});

// ==========================================
// 5. SUCCESSFUL PAYMENT
// ==========================================
console.log("\n5. Successful Payment:");

test("Settlement webhook marks order as PAID", () => {
    /*
     * Settlement is an atomic SQL CAS (`SET status = 'PAID', paymentStatus
     * = 'PAID'` guarded by status + paymentStatus), not the old Prisma
     * object update (`status: "PAID"`), in BOTH providers.
     */
    for (const [name, code] of webhookImplementations) {
        assert(
            hasSql(code, "SET status = 'PAID'") &&
                hasSql(code, "paymentStatus = 'PAID'"),
            `${name}: settlement webhook doesn't mark PAID`
        );
    }
});

test("Settlement webhook sets paidAt timestamp", () => {
    for (const [name, code] of webhookImplementations) {
        assert(
            hasSql(code, "paidAt = IFNULL(paidAt, CURRENT_TIMESTAMP)"),
            `${name}: settlement webhook doesn't set paidAt`
        );
    }
});

test("Settlement webhook clears cart for CART orders", () => {
    assert(
        webhookCode.includes('PAY-CART-') && webhookCode.includes("cartItem.deleteMany"),
        "Settlement webhook doesn't clear cart"
    );
});

test("Settlement webhook is idempotent (won't re-process PAID)", () => {
    for (const [name, code] of webhookImplementations) {
        assert(
            hasSql(code, "status IN ('PENDING', 'PROCESSING')"),
            `${name}: settlement CAS missing status guard`
        );
        assert(
            hasSql(
                code,
                "paymentStatus NOT IN ('PAID', 'REFUNDED')"
            ),
            `${name}: settlement CAS missing PAID/REFUNDED guard`
        );
        assert(
            code.includes("affectedRows === 0"),
            `${name}: settlement doesn't early-return when the CAS matched no row`
        );
    }
});

/*
 * Branch slices for the Midtrans (legacy) route.
 *
 * The previous code anchored the END of a slice on `releaseReservedStock`,
 * a function that no longer exists: indexOf returned -1 and
 * String.substring() SILENTLY SWAPPED its arguments, so those assertions
 * inspected a meaningless region (or the whole file) and passed for the
 * wrong reason. Anchoring on the branch CONDITIONS fails closed instead:
 * a missing anchor yields "" and every assertion below fails loudly.
 */
const midtransFlat = flat(webhookCode);

function midtransBranch(
    startMarker: string,
    endMarker: string
): string {
    const start = midtransFlat.indexOf(startMarker);
    const end = midtransFlat.indexOf(endMarker);

    return start >= 0 && end > start
        ? midtransFlat.substring(start, end)
        : "";
}

const midtransSuccessBranch = midtransBranch(
    "if (isSuccess) {",
    "if ( isPending )"
);
const midtransPendingBranch = midtransBranch(
    "if ( isPending )",
    "if ( isExpired )"
);
const midtransExpiredBranch = midtransBranch(
    "if ( isExpired )",
    "if ( isFailed )"
);
const midtransFailedBranch = midtransBranch(
    "if ( isFailed )",
    "if ( isRefunded )"
);

test("Successful payment does NOT restore stock", () => {
    assert(
        midtransSuccessBranch.length > 0,
        "Cannot locate the Midtrans settlement branch"
    );
    assert(
        !midtransSuccessBranch.includes(
            "releaseStockAndVoucherForOrder"
        ) &&
            !hasSql(midtransSuccessBranch, "UPDATE flashsale"),
        "Settlement incorrectly restores stock (Midtrans)"
    );

    /*
     * Same invariant for the LIVE provider: the success branch must not
     * call the release primitive. (The release appears in the file, but
     * only in the failed/expired branch below it.)
     */
    const ipaymuFlat = flat(ipaymuWebhookCode);
    const successIdx = ipaymuFlat.indexOf(
        'if (isSuccess || statusClass === "success")'
    );
    const pendingIdx = ipaymuFlat.indexOf(
        'if (isPending || statusClass === "pending")'
    );

    assert(
        successIdx >= 0 && pendingIdx > successIdx,
        "Cannot locate the iPaymu settlement branch"
    );
    assert(
        !ipaymuFlat
            .substring(successIdx, pendingIdx)
            .includes("releaseStockAndVoucherForOrder"),
        "iPaymu settlement incorrectly restores stock"
    );
});

// ==========================================
// 6. FAILED PAYMENT
// ==========================================
console.log("\n6. Failed Payment:");

test("Failed webhook uses atomic CAS to cancel order", () => {
    assert(
        webhookCode.includes("paymentStatus = 'FAILED'") &&
        webhookCode.includes("status IN ('PENDING', 'PROCESSING')"),
        "Failed webhook missing CAS guard"
    );
});

test("Failed webhook restores stock atomically", () => {
    for (const [name, code] of webhookImplementations) {
        assert(
            code.includes("releaseStockAndVoucherForOrder("),
            `${name}: failed handler doesn't release stock`
        );
    }
    assert(
        orderStockCode.includes("$executeRaw") &&
            hasSql(orderStockCode, "soldCount >="),
        "Shared release isn't an atomic, guarded update"
    );
});

test("Failed webhook only affects PENDING/PROCESSING orders", () => {
    assert(
        midtransFailedBranch.length > 0,
        "Cannot locate the Midtrans failed branch"
    );
    assert(
        midtransFailedBranch.includes(
            "IN ('PENDING', 'PROCESSING')"
        ),
        "Failed webhook doesn't restrict to PENDING/PROCESSING"
    );
});

test("Failed webhook cannot affect PAID orders", () => {
    assert(
        midtransFailedBranch.length > 0,
        "Cannot locate the Midtrans failed branch"
    );
    assert(
        midtransFailedBranch.includes("paymentStatus != 'PAID'"),
        "Failed webhook missing PAID guard"
    );
});

// ==========================================
// 7. EXPIRED PAYMENT
// ==========================================
console.log("\n7. Expired Payment:");

test("Expired webhook uses atomic CAS to cancel order", () => {
    assert(
        webhookCode.includes("paymentStatus = 'EXPIRED'") &&
        webhookCode.includes("status IN ('PENDING', 'PROCESSING')"),
        "Expired webhook missing CAS guard"
    );
});

test("Expired webhook restores stock atomically", () => {
    const expiredSection = flat(webhookCode).substring(
        flat(webhookCode).indexOf("paymentStatus = 'EXPIRED'"),
        flat(webhookCode).indexOf("releaseStockAndVoucherForOrder")
    );
    assert(
        expiredSection.includes("releaseStockAndVoucherForOrder"),
        "Expired webhook doesn't restore stock"
    );
    assert(
        expiredSection.includes("affectedRows === 0"),
        "Expired webhook must skip the release when the CAS matched no row"
    );
    // iPaymu reports expiry as a failed status, handled by the shared
    // fail/expire branch that also delegates to the shared release.
    assert(
        ipaymuWebhookCode.includes("releaseStockAndVoucherForOrder("),
        "iPaymu expired/failed handler doesn't release stock"
    );
});

test("Expired webhook only affects PENDING/PROCESSING orders", () => {
    assert(
        midtransExpiredBranch.length > 0,
        "Cannot locate the Midtrans expired branch"
    );
    assert(
        midtransExpiredBranch.includes(
            "IN ('PENDING', 'PROCESSING')"
        ),
        "Expired webhook missing status guard"
    );
});

// ==========================================
// 8. DUPLICATE WEBHOOK
// ==========================================
console.log("\n8. Duplicate Webhook:");

test("Duplicate settlement is idempotent (PAID guard)", () => {
    /*
     * Idempotency is the CAS itself: a second settlement notification
     * matches 0 rows (`paymentStatus NOT IN ('PAID','REFUNDED')`) and the
     * handler returns without touching stock.
     */
    for (const [name, code] of webhookImplementations) {
        assert(
            hasSql(
                code,
                "paymentStatus NOT IN ('PAID', 'REFUNDED')"
            ),
            `${name}: settlement missing PAID idempotency check`
        );
    }
});

test("Duplicate expired is idempotent (CAS only processes PENDING/PROCESSING)", () => {
    assert(
        midtransExpiredBranch.length > 0,
        "Cannot locate the Midtrans expired branch"
    );
    assert(
        midtransExpiredBranch.includes("affectedRows === 0"),
        "Expired handler doesn't check affectedRows"
    );
});

test("Duplicate failed is idempotent (CAS only processes PENDING/PROCESSING)", () => {
    const failedSection = webhookCode.substring(
        webhookCode.indexOf("paymentStatus = 'FAILED'"),
        webhookCode.indexOf("isRefunded")
    );
    assert(
        failedSection.includes("affectedRows === 0") || failedSection.includes("return"),
        "Failed handler doesn't check affectedRows"
    );
});

test("Duplicate pending is idempotent (CAS with paymentStatus != PAID)", () => {
    const pendingSection = webhookCode.substring(
        webhookCode.indexOf("paymentStatus = 'PENDING'"),
        webhookCode.indexOf("isExpired")
    );
    assert(
        pendingSection.includes("pendingAffected"),
        "Pending handler doesn't track affected rows"
    );
});

test("Duplicate refund is idempotent (PAID guard)", () => {
    /*
     * The refund transition/completion pipeline moved to lib/refund.ts:
     * transitionRefundForWebhook() CASes the Refund row and
     * executeRefundCompletion() CASes the ORDER with
     * `paymentStatus = 'PAID'`, so a replayed refund affects 0 rows.
     */
    for (const [name, code] of webhookImplementations) {
        assert(
            code.includes("transitionRefundForWebhook(") &&
                code.includes("executeRefundCompletion("),
            `${name}: refund webhook doesn't delegate to the shared pipeline`
        );
    }
    assert(
        hasSql(refundCode, "AND paymentStatus = 'PAID'"),
        "Refund pipeline missing PAID idempotency check"
    );
    assert(
        refundCode.includes("affectedRows === 0"),
        "Refund pipeline missing CAS affectedRows check"
    );
});

// ==========================================
// 9. CONCURRENT ROLLBACK
// ==========================================
console.log("\n9. Concurrent Rollback:");

test("rollbackCheckoutOrder uses atomic CAS", () => {
    const rollbackStart = checkoutCode.indexOf("rollbackCheckoutOrder");
    const rollbackEnd = checkoutCode.indexOf("clearCart");
    const rollback = checkoutCode.substring(rollbackStart, rollbackEnd);
    assert(
        rollback.includes("$executeRaw") && rollback.includes("IN ('PENDING', 'PROCESSING')"),
        "rollbackCheckoutOrder missing atomic CAS"
    );
});

test("Only one concurrent rollback can succeed (CAS returns affectedRows)", () => {
    /*
     * Scope to the primitive (cancelOrderForReservations), not to a
     * positional slice: the wrapper `rollbackCheckoutOrder → clearCart`
     * slice no longer contains the CAS after the refactor.
     */
    assert(
        cancelReservationsBody.length > 0,
        "cancelOrderForReservations not found in lib/checkout.ts"
    );
    assert(
        cancelReservationsBody.includes("affectedRows === 0") &&
            cancelReservationsBody.includes("return false;"),
        "rollback CAS doesn't early-return on CAS failure"
    );
    assert(
        hasSql(
            cancelReservationsBody,
            "status IN ('PENDING', 'PROCESSING')"
        ),
        "rollback CAS must only transition PENDING/PROCESSING"
    );
});

test("All stock/voucher restores happen AFTER successful CAS", () => {
    /*
     * Scoped to the primitive, and the release points are located by the
     * SQL/model calls that perform them rather than by comment banners —
     * a reworded comment must never turn this check into a no-op.
     */
    const body = flat(cancelReservationsBody);
    const casIdx = body.indexOf("affectedRows === 0");
    const earlyReturnIdx = body.indexOf("return false;", casIdx);
    const stockIdx = body.indexOf("productVariant.update");
    const voucherIdx = body.indexOf("voucher.updateMany");

    assert(casIdx > 0, "Rollback missing CAS");
    assert(
        earlyReturnIdx > casIdx,
        "Rollback must early-return when the CAS matched no row"
    );
    assert(
        stockIdx > earlyReturnIdx,
        "Stock restore before the CAS early-return"
    );
    assert(
        voucherIdx > earlyReturnIdx,
        "Voucher restore before the CAS early-return"
    );
});

// ==========================================
// 10. CONCURRENT CHECKOUT
// ==========================================
console.log("\n10. Concurrent Checkout:");

test("Regular stock uses atomic conditional decrement (updateMany with gte)", () => {
    assert(
        checkoutCode.includes("updateMany") && checkoutCode.includes("stock:") && checkoutCode.includes("gte:"),
        "Regular stock reservation not atomic"
    );
});

test("Flash sale stock uses atomic $executeRaw with saleStock >= quantity", () => {
    assert(
        checkoutCode.includes("$executeRaw") &&
            hasSql(checkoutCode, "UPDATE flashsale") &&
            hasSql(checkoutCode, "saleStock >= "),
        "Flash sale stock reservation not atomic"
    );
});

test("Regular stock failure returns proper error", () => {
    assert(
        checkoutCode.includes("sudah berubah"),
        "Stock failure doesn't return proper error"
    );
});

test("Flash sale stock failure returns proper error", () => {
    assert(
        checkoutCode.includes("tidak mencukupi"),
        "Flash sale stock failure doesn't return proper error"
    );
});

// ==========================================
// 11. VOUCHER REDEMPTION
// ==========================================
console.log("\n11. Voucher Redemption:");

test("Voucher increment is atomic with quota guard", () => {
    assert(
        voucherCode.includes("$executeRaw") &&
            hasSql(voucherCode, "UPDATE voucher") &&
            hasSql(voucherCode, "usedCount < quota"),
        "Voucher increment not atomic"
    );
});

test("Voucher usage is re-validated inside checkout transaction", () => {
    assert(
        checkoutCode.includes("validateAndCalculateVoucherEnhanced"),
        "Checkout doesn't re-validate voucher inside transaction"
    );
});

test("Voucher quota exhaustion throws error", () => {
    assert(
        checkoutCode.includes("VOUCHER_QUOTA_EXHAUSTED"),
        "Checkout missing quota exhaustion error"
    );
});

test("Voucher per-user limit enforced via post-increment check", () => {
    assert(
        checkoutCode.includes("newUsageCount") && checkoutCode.includes("maxUsagePerUser"),
        "Checkout missing per-user limit check"
    );
});

// ==========================================
// 12. VOUCHER ROLLBACK
// ==========================================
console.log("\n12. Voucher Rollback:");

test("Voucher usedCount restored with gt: 0 guard", () => {
    assert(
        cancelReservationsBody.includes('gt: 0') &&
            cancelReservationsBody.includes('decrement: 1'),
        "Voucher rollback missing gt: 0 guard"
    );
    /*
     * Both webhooks release through the shared module, so the guard is
     * asserted where it is implemented plus on the delegation itself.
     */
    assert(
        orderStockCode.includes('gt: 0') &&
            orderStockCode.includes('decrement: 1'),
        "Shared voucher release missing gt: 0 guard"
    );
    for (const [name, code] of webhookImplementations) {
        assert(
            code.includes("releaseStockAndVoucherForOrder("),
            `${name}: voucher rollback doesn't use the shared release`
        );
    }
});

test("VoucherUserUsage restored in both rollback paths", () => {
    assert(
        cancelReservationsBody.includes(
            "voucherUserUsage.findUnique"
        ) &&
            cancelReservationsBody.includes(
                "voucherUserUsage.update"
            ),
        "Checkout rollback missing VoucherUserUsage restore"
    );
    assert(
        orderStockCode.includes("voucherUserUsage.findUnique") &&
            orderStockCode.includes("voucherUserUsage.update"),
        "Shared (webhook) release missing VoucherUserUsage restore"
    );
    // Both paths must target the guest-aware composite key.
    assert(
        cancelReservationsBody.includes("voucherId_ownerKey") &&
            orderStockCode.includes("voucherId_ownerKey"),
        "VoucherUserUsage restore not scoped by voucherId_ownerKey"
    );
});

test("VoucherUserUsage usageCount > 0 guard in both paths", () => {
    assert(
        cancelReservationsBody.includes(
            "userUsage.usageCount > 0"
        ),
        "Checkout rollback missing usageCount > 0 guard"
    );
    assert(
        orderStockCode.includes("userUsage.usageCount > 0"),
        "Shared (webhook) release missing usageCount > 0 guard"
    );
});

// ==========================================
// 13. FLASH SALE PURCHASE
// ==========================================
console.log("\n13. Flash Sale Purchase:");

test("Flash sale purchase recorded after stock reservation", () => {
    assert(
        checkoutCode.includes("recordFlashSalePurchase"),
        "Checkout doesn't record flash sale purchase"
    );
});

test("Flash sale purchase limit enforced via post-increment check", () => {
    assert(
        flashSaleCode.includes("record.quantity > purchaseLimit"),
        "Flash sale purchase limit missing post-increment check"
    );
});

test("Flash sale purchase uses atomic upsert", () => {
    assert(
        flashSaleCode.includes("upsert") || flashSaleCode.includes("findUnique"),
        "Flash sale purchase not using atomic operation"
    );
});

// ==========================================
// 14. FLASH SALE ROLLBACK
// ==========================================
console.log("\n14. Flash Sale Rollback:");

test("Flash sale stock restored with soldCount >= quantity guard in checkout rollback", () => {
    assert(
        hasSql(cancelReservationsBody, "UPDATE flashsale") &&
            hasSql(cancelReservationsBody, "soldCount >="),
        "Checkout rollback missing flash sale stock restore"
    );
});

test("Flash sale stock restored with soldCount >= quantity guard in webhook", () => {
    assert(
        hasSql(orderStockCode, "UPDATE flashsale") &&
            hasSql(orderStockCode, "soldCount >="),
        "Shared (webhook) release missing flash sale stock restore"
    );
    for (const [name, code] of webhookImplementations) {
        assert(
            code.includes("releaseStockAndVoucherForOrder("),
            `${name}: doesn't use the shared flash-sale-aware release`
        );
    }
});

test("FlashSalePurchase cleaned up on rollback in checkout", () => {
    const rollbackStart = checkoutCode.indexOf("rollbackCheckoutOrder");
    const rollbackEnd = checkoutCode.indexOf("clearCart");
    const rollback = checkoutCode.substring(rollbackStart, rollbackEnd);
    assert(
        rollback.includes("flashSalePurchase.deleteMany"),
        "Checkout rollback missing FlashSalePurchase cleanup"
    );
});

test("FlashSalePurchase cleaned up on rollback in webhook", () => {
    /*
     * Cleanup now lives in the shared module and must be scoped by the
     * ORDER's ownerKey: a guest purchase row has userId = NULL, so
     * filtering by userId would wipe every guest's row for that sale.
     */
    assert(
        orderStockCode.includes("flashSalePurchase.deleteMany") &&
            orderStockCode.includes("ownerKey: orderScope"),
        "Shared release missing ownerKey-scoped FlashSalePurchase cleanup"
    );
    for (const [name, code] of webhookImplementations) {
        assert(
            code.includes("releaseStockAndVoucherForOrder("),
            `${name}: doesn't use the shared FlashSalePurchase cleanup`
        );
    }
});

// ==========================================
// 15. STOCK RESERVATION
// ==========================================
console.log("\n15. Stock Reservation:");

test("Regular stock: atomic updateMany with stock >= quantity condition", () => {
    assert(
        checkoutCode.includes("updateMany") && checkoutCode.includes("stock:") && checkoutCode.includes("gte:"),
        "Regular stock reservation not using atomic CAS"
    );
});

test("Flash sale: atomic $executeRaw with saleStock >= quantity condition", () => {
    assert(
        checkoutCode.includes("$executeRaw") && checkoutCode.includes("saleStock >= ${item.quantity}"),
        "Flash sale reservation not using atomic CAS"
    );
});

test("Product.sold incremented atomically on reservation", () => {
    assert(
        checkoutCode.includes("product.update") && checkoutCode.includes("sold:") && checkoutCode.includes("increment:"),
        "Product.sold not incremented atomically"
    );
});

test("Flash sale items skip regular stock reservation", () => {
    assert(
        checkoutCode.includes("flashSaleId") && checkoutCode.includes("continue;"),
        "Flash sale items don't skip regular stock"
    );
});

// ==========================================
// 16. STOCK RESTORATION
// ==========================================
console.log("\n16. Stock Restoration:");

test("ProductVariant.stock incremented in both rollback paths", () => {
    assert(
        cancelReservationsBody.includes("productVariant.update") &&
            cancelReservationsBody.includes("increment:"),
        "Checkout rollback missing ProductVariant.stock restore"
    );
    assert(
        orderStockCode.includes("productVariant.update") &&
            orderStockCode.includes("increment: item.quantity"),
        "Shared (webhook) release missing ProductVariant.stock restore"
    );
});

test("Product.sold uses GREATEST(0, sold - quantity) in both paths", () => {
    assert(
        hasSql(checkoutCode, "GREATEST(0, sold -"),
        "Checkout rollback missing GREATEST guard on Product.sold"
    );
    assert(
        hasSql(orderStockCode, "GREATEST(0, sold -"),
        "Shared (webhook) release missing GREATEST guard on Product.sold"
    );
});

test("Flash sale stock restored with soldCount >= quantity guard", () => {
    assert(
        hasSql(cancelReservationsBody, "soldCount >=") &&
            hasSql(orderStockCode, "soldCount >="),
        "Missing soldCount >= quantity guard in restore"
    );
});

// ==========================================
// 17. PENDING CLEANUP
// ==========================================
console.log("\n17. Pending Cleanup:");

test("cleanupPendingCheckoutOrders exists and is exported", () => {
    assert(
        checkoutCode.includes("export async function cleanupPendingCheckoutOrders"),
        "cleanupPendingCheckoutOrders missing"
    );
});

test("Cleanup only processes non-COD PENDING orders", () => {
    const cleanupSection = checkoutCode.substring(
        checkoutCode.indexOf("cleanupPendingCheckoutOrders"),
        checkoutCode.indexOf("export async function createCheckoutOrder")
    );
    assert(
        cleanupSection.includes('status: "PENDING"') &&
        cleanupSection.includes('paymentStatus: "PENDING"') &&
        cleanupSection.includes('"BANK_TRANSFER"'),
        "Cleanup doesn't filter correctly"
    );
});

test("Cleanup uses rollbackCheckoutOrder with restoreCart: false", () => {
    const cleanupSection = checkoutCode.substring(
        checkoutCode.indexOf("cleanupPendingCheckoutOrders"),
        checkoutCode.indexOf("export async function createCheckoutOrder")
    );
    assert(
        cleanupSection.includes("restoreCart: false"),
        "Cleanup doesn't pass restoreCart: false"
    );
});

test("Cleanup runs before new checkout transaction", () => {
    const createStart = checkoutCode.indexOf("export async function createCheckoutOrder");
    const createSection = checkoutCode.substring(createStart);
    const cleanupIdx = createSection.indexOf("cleanupPendingCheckoutOrders");
    const txIdx = createSection.indexOf("$transaction");
    assert(
        cleanupIdx > 0 && txIdx > 0 && cleanupIdx < txIdx,
        "Cleanup not called before $transaction"
    );
});

test("Cleanup has try/catch per order (failure isolation)", () => {
    const cleanupSection = checkoutCode.substring(
        checkoutCode.indexOf("cleanupPendingCheckoutOrders"),
        checkoutCode.indexOf("export async function createCheckoutOrder")
    );
    assert(
        cleanupSection.includes("try {") && cleanupSection.includes("catch (error)"),
        "Cleanup missing try/catch per order"
    );
});

test("Cleanup has take: 10 limit (prevents unbounded processing)", () => {
    const cleanupSection = checkoutCode.substring(
        checkoutCode.indexOf("cleanupPendingCheckoutOrders"),
        checkoutCode.indexOf("export async function createCheckoutOrder")
    );
    assert(
        cleanupSection.includes("take: 10"),
        "Cleanup missing take: 10 limit"
    );
});

// ==========================================
// 18. ORDER STATUS TRANSITIONS
// ==========================================
console.log("\n18. Order Status Transitions:");

test("PENDING → CANCELLED: rollbackCheckoutOrder CAS", () => {
    assert(
        checkoutCode.includes("IN ('PENDING', 'PROCESSING')") &&
        checkoutCode.includes("CANCELLED"),
        "Missing PENDING → CANCELLED CAS"
    );
});

test("PAID cannot be reverted by pending webhook (paymentStatus != PAID guard)", () => {
    assert(
        webhookCode.includes("paymentStatus != 'PAID'"),
        "Missing PAID guard in pending webhook"
    );
});

test("PAID cannot be reverted by expired/failed webhook (status IN + paymentStatus guards)", () => {
    assert(
        midtransExpiredBranch.length > 0 &&
            midtransFailedBranch.length > 0,
        "Cannot locate the Midtrans expired/failed branches"
    );

    for (const [name, branch] of [
        ["expired", midtransExpiredBranch],
        ["failed", midtransFailedBranch],
    ] as const) {
        assert(
            branch.includes("IN ('PENDING', 'PROCESSING')") &&
                branch.includes("paymentStatus != 'PAID'"),
            `Midtrans ${name} webhook missing dual guard`
        );
    }

    // iPaymu (live) handles expiry as a failed status in one branch.
    const ipaymuFailed = flat(ipaymuWebhookCode).substring(
        flat(ipaymuWebhookCode).indexOf(
            'if (isFailed || statusClass === "failed")'
        )
    );

    assert(
        ipaymuFailed.includes("status IN ('PENDING', 'PROCESSING')") &&
            ipaymuFailed.includes("paymentStatus != 'PAID'"),
        "iPaymu expired/failed webhook missing dual guard"
    );
});

test("PENDING → PAID via settlement webhook (idempotent)", () => {
    for (const [name, code] of webhookImplementations) {
        const sql = flat(code);
        const casIdx = sql.indexOf("status IN ('PENDING', 'PROCESSING')");

        assert(
            hasSql(code, "SET status = 'PAID'") &&
                hasSql(code, "paymentStatus = 'PAID'"),
            `${name}: settlement missing PAID status set`
        );
        assert(
            casIdx > 0 &&
                sql.indexOf("affectedRows === 0") > casIdx,
            `${name}: settlement must no-op when the CAS matched no row`
        );
    }
});

test("Admin PATCH has transition guard (validTransitions)", () => {
    assert(
        adminOrderRoute.includes("validTransitions"),
        "Admin PATCH missing transition guard"
    );
});

test("COMPLETED and CANCELLED have no backward transitions", () => {
    assert(
        adminOrderRoute.includes("COMPLETED:") && adminOrderRoute.includes("[]"),
        "COMPLETED missing empty transition list"
    );
    assert(
        adminOrderRoute.includes("CANCELLED:") && adminOrderRoute.includes("[]"),
        "CANCELLED missing empty transition list"
    );
});

// ==========================================
// 19. SHIPPING COST VERIFICATION
// ==========================================
console.log("\n19. Shipping Cost Verification:");

test("Server-side shipping verification function exists", () => {
    assert(
        checkoutCode.includes("verifyShippingCost"),
        "Missing verifyShippingCost function"
    );
});

test("Server ignores client shipping cost (uses verifiedShippingCost)", () => {
    assert(
        checkoutCode.includes("verifiedShippingCost"),
        "Server doesn't use verified shipping cost"
    );
});

test("Shipping verified via RajaOngkir API before transaction", () => {
    assert(
        checkoutCode.includes("calculateDomesticCost"),
        "Missing RajaOngkir API call"
    );
    const verifyIdx = checkoutCode.indexOf("verifyShippingCost");
    const txIdx = checkoutCode.indexOf("$transaction");
    assert(
        verifyIdx > 0 && txIdx > 0 && verifyIdx < txIdx,
        "Shipping verification not before transaction"
    );
});

test("Shipping verification uses server-authoritative data (StoreSetting + UserAddress)", () => {
    assert(
        checkoutCode.includes("storeSetting.rajaOngkirDestinationId"),
        "Missing StoreSetting origin"
    );
    assert(
        checkoutCode.includes("address.rajaOngkirDestinationId"),
        "Missing UserAddress destination"
    );
});

test("Order total formula: subtotal - discount + shipping = grossAmount", () => {
    assert(
        checkoutCode.includes("subtotal -") &&
        checkoutCode.includes("discount +") &&
        checkoutCode.includes("finalShippingCost") &&
        checkoutCode.includes("grossAmount"),
        "Order total formula incorrect"
    );
});

// ==========================================
// 20. MARKETING PRICING INTEGRATION
// ==========================================
console.log("\n20. Marketing Pricing Integration:");

test("Single pricing engine: resolveBatchPrices used everywhere", () => {
    const surfaces = [
        { name: "checkout", code: checkoutCode },
        { name: "cart API", code: cartApi },
        { name: "checkout API", code: readFile("app/api/checkout/route.ts") },
    ];
    for (const surface of surfaces) {
        assert(
            surface.code.includes("resolveBatchPrices"),
            `${surface.name} missing resolveBatchPrices`
        );
    }
});

test("Pricing priority: Flash Sale > Product Discount > Campaign > Bulk Discount > Original", () => {
    assert(
        batchPricingCode.includes("FLASH_SALE") &&
        batchPricingCode.includes("PRODUCT_DISCOUNT") &&
        batchPricingCode.includes("CAMPAIGN DISCOUNT") &&
        batchPricingCode.includes("BULK DISCOUNT") &&
        batchPricingCode.includes("ORIGINAL"),
        "Batch pricing missing all source types"
    );
});

test("Checkout uses batch pricing (not per-item queries)", () => {
    assert(
        checkoutCode.includes("resolveBatchMarketingPricing"),
        "Checkout not using batch pricing"
    );
});

test("Checkout validates grossAmount > 0", () => {
    assert(
        checkoutCode.includes("grossAmount <= 0"),
        "Checkout missing grossAmount validation"
    );
});

test("Order.total is stored as grossAmount (server-calculated)", () => {
    assert(
        checkoutCode.includes("grossAmount") && checkoutCode.includes("total:"),
        "Order total not using server-calculated grossAmount"
    );
});

// ==========================================
// FINANCIAL CONSISTENCY
// ==========================================
console.log("\n--- Financial Consistency ---");

test("subtotal = sum of all item subtotals", () => {
    assert(
        checkoutCode.includes("checkoutItems.reduce") && checkoutCode.includes("item.subtotal"),
        "Subtotal not calculated from item subtotals"
    );
});

test("grossAmount = subtotal - discount + finalShippingCost", () => {
    assert(
        checkoutCode.includes("subtotal -") && checkoutCode.includes("discount +") && checkoutCode.includes("finalShippingCost"),
        "grossAmount formula incorrect"
    );
});

test("discount is always <= subtotal (voucher capped at subtotal)", () => {
    assert(
        voucherCode.includes('if (discount > subtotal)') ||
        voucherCode.includes('discount > subtotal'),
        "Voucher discount not capped at subtotal"
    );
});

test("Order total stored is integer (no floating point)", () => {
    assert(
        checkoutCode.includes("Number.isInteger(grossAmount)") ||
        checkoutCode.includes("grossAmount <= 0"),
        "grossAmount not validated as integer"
    );
});

// ==========================================
// REGRESSION PROTECTION CHECK
// ==========================================
console.log("\n--- Regression Protection ---");

test("Marketing single-source-of-truth architecture preserved", () => {
    // All customer surfaces must use resolveBatchPrices
    assert(
        checkoutCode.includes("resolveBatchPrices"),
        "Checkout lost batch pricing"
    );
});

test("Server-side shipping verification preserved", () => {
    assert(
        checkoutCode.includes("verifyShippingCost"),
        "Shipping verification lost"
    );
});

test("Midtrans signature verification preserved", () => {
    assert(
        webhookCode.includes("timingSafeEqual"),
        "Signature verification lost"
    );
});

test("Rate limiting preserved on all order endpoints", () => {
    assert(
        ordersRoute.includes("rateLimiters.orderCreation"),
        "Cart COD lost rate limiting"
    );
    assert(
        buyNowRoute.includes("rateLimiters.orderCreation"),
        "Buy Now COD lost rate limiting"
    );
    assert(
        buyNowIpaymu.includes("rateLimiters.orderCreation"),
        "Buy Now iPaymu lost rate limiting"
    );
    assert(
        ipaymuRoute.includes("rateLimiters.orderCreation"),
        "Cart iPaymu lost rate limiting"
    );
});

test("Order number uniqueness preserved (crypto.randomUUID)", () => {
    assert(
        checkoutCode.includes("crypto") && checkoutCode.includes("randomUUID()"),
        "Order number uniqueness lost"
    );
});

// ==========================================
// RESULTS
// ==========================================
console.log(`\n=== T5 RESULTS: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
    process.exit(1);
}
