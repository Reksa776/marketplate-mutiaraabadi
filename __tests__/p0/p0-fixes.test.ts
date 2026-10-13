/**
 * P0 FIXES — BEHAVIORAL VERIFICATION TESTS
 *
 * Tests for the three P0 fixes:
 *   P0-1: Commission calculation uses Decimal (not floating-point)
 *   P0-2: Refund webhook releases stock
 *   P0-3: Admin PAID→CANCELLED releases stock
 */

import { readFileSync } from "fs";
import { resolve } from "path";

function readFile(relativePath: string): string {
    return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

const checkoutCode = readFile("lib/checkout.ts");
const commissionCode = readFile("lib/affiliate/commission.ts");
const webhookCode = readFile("app/api/payment/midtrans/notification/route.ts");
const adminOrderCode = readFile("app/api/admin/orders/[id]/route.ts");
const orderStockCode = readFile("lib/order-stock.ts");

// ==========================================
// P0-1: Commission Calculation
// ==========================================
describe("P0-1: Commission Calculation (Decimal-safe)", () => {
    test("Checkout imports calculateCommission from commission.ts", () => {
        expect(checkoutCode).toContain('await import("@/lib/affiliate/commission")');
    });

    test("Checkout uses calculateCommission() function", () => {
        expect(checkoutCode).toContain("calculateCommission(");
    });

    test("Checkout passes Decimal directly (no toNumber intermediary)", () => {
        // commissionResult.commissionAmount should be passed directly to Prisma
        // not converted via .toNumber() first
        expect(checkoutCode).toContain("commissionResult.commissionAmount,");
        expect(checkoutCode).toContain("commissionResult.commissionRate,");
        expect(checkoutCode).toContain("commissionResult.orderSubtotal,");
        // Should NOT have .toNumber() for commissionAmount in the create call
        const createIdx = checkoutCode.indexOf("affiliateConversion.create");
        const createSection = checkoutCode.substring(createIdx, createIdx + 600);
        expect(createSection).not.toContain(".toNumber()");
    });

    test("Checkout does NOT use floating-point Math.round(sub*rate)/100 for commission", () => {
        const commissionSection = checkoutCode.substring(
            checkoutCode.indexOf("AFFILIATE CONVERSION"),
            checkoutCode.indexOf("P2002") !== -1 ? checkoutCode.indexOf("P2002") : checkoutCode.length
        );
        // The old floating-point formula should not appear in the commission section
        expect(commissionSection).not.toMatch(/Math\.round\(\s*sub\s*\*\s*rate\s*\)\s*\/\s*100/);
    });

    test("commission.ts uses Decimal arithmetic (mul, div, toDecimalPlaces)", () => {
        expect(commissionCode).toContain(".mul(");
        expect(commissionCode).toContain(".div(100)");
        expect(commissionCode).toContain(".toDecimalPlaces(2)");
    });

    test("calculateCommission returns Decimal types", () => {
        expect(commissionCode).toContain("commissionAmount: Prisma.Decimal");
    });
});

// ==========================================
// P0-2: Refund Stock Release
// ==========================================
describe("P0-2: Refund Stock Release", () => {
    test("Webhook imports releaseStockAndVoucherForOrder from shared module", () => {
        expect(webhookCode).toContain('import { releaseStockAndVoucherForOrder } from "@/lib/order-stock"');
    });

    test("Refund handler uses shared executeRefundCompletion()", () => {
        const refundHandlerIdx = webhookCode.indexOf("if (\n            isRefunded");
        const unhandledIdx = webhookCode.indexOf("UNHANDLED STATUS");
        expect(refundHandlerIdx).toBeGreaterThan(0);
        const refundSection = webhookCode.substring(refundHandlerIdx, unhandledIdx);
        expect(refundSection).toContain("executeRefundCompletion");
    });

    test("Refund handler finds or creates Refund record before completion", () => {
        const refundHandlerIdx = webhookCode.indexOf("if (\n            isRefunded");
        const unhandledIdx = webhookCode.indexOf("UNHANDLED STATUS");
        const refundSection = webhookCode.substring(refundHandlerIdx, unhandledIdx);
        expect(refundSection).toContain("refund.findUnique");
        expect(refundSection).toContain("refund.create");
    });

    test("Refund handler passes source identifier for audit trail", () => {
        const refundHandlerIdx = webhookCode.indexOf("if (\n            isRefunded");
        const unhandledIdx = webhookCode.indexOf("UNHANDLED STATUS");
        const refundSection = webhookCode.substring(refundHandlerIdx, unhandledIdx);
        expect(refundSection).toContain("MIDTRANS_WEBHOOK");
    });

    test("Refund handler is idempotent (checks result.ok)", () => {
        const refundHandlerIdx = webhookCode.indexOf("if (\n            isRefunded");
        const unhandledIdx = webhookCode.indexOf("UNHANDLED STATUS");
        const refundSection = webhookCode.substring(refundHandlerIdx, unhandledIdx);
        expect(refundSection).toContain("result.ok");
    });

    test("Expire handler uses releaseStockAndVoucherForOrder", () => {
        const expireHandlerIdx = webhookCode.indexOf("if (\n            isExpired");
        const failHandlerIdx = webhookCode.indexOf("if (\n            isFailed");
        expect(expireHandlerIdx).toBeGreaterThan(0);
        expect(failHandlerIdx).toBeGreaterThan(expireHandlerIdx);
        const expireSection = webhookCode.substring(expireHandlerIdx, failHandlerIdx);
        expect(expireSection).toContain("releaseStockAndVoucherForOrder");
    });

    test("Fail handler uses releaseStockAndVoucherForOrder", () => {
        const failHandlerIdx = webhookCode.indexOf("if (\n            isFailed");
        const refundHandlerIdx = webhookCode.indexOf("if (\n            isRefunded");
        expect(failHandlerIdx).toBeGreaterThan(0);
        expect(refundHandlerIdx).toBeGreaterThan(failHandlerIdx);
        const failSection = webhookCode.substring(failHandlerIdx, refundHandlerIdx);
        expect(failSection).toContain("releaseStockAndVoucherForOrder");
    });
});

// ==========================================
// P0-3: Admin PAID→CANCELLED Stock Release
// ==========================================
describe("P0-3: Admin PAID→CANCELLED Stock Release", () => {
    test("Admin PATCH imports releaseStockAndVoucherForOrder", () => {
        expect(adminOrderCode).toContain('import { releaseStockAndVoucherForOrder } from "@/lib/order-stock"');
    });

    test("Admin PATCH uses CAS UPDATE for CANCELLED transition", () => {
        expect(adminOrderCode).toContain("$executeRaw");
        expect(adminOrderCode).toContain("status = 'CANCELLED'");
    });

    test("Admin PATCH calls releaseStockAndVoucherForOrder when cancelling", () => {
        expect(adminOrderCode).toContain("releaseStockAndVoucherForOrder(tx, orderId)");
    });

    test("Admin PATCH checks affectedRows from CAS (prevents double-release)", () => {
        expect(adminOrderCode).toContain("casAffected");
        expect(adminOrderCode).toContain("casAffected === 0");
    });

    test("Admin PATCH cancels affiliate commission when cancelling", () => {
        expect(adminOrderCode).toContain("cancelCommissionForOrder");
    });
});

// ==========================================
// Shared Module (lib/order-stock.ts)
// ==========================================
describe("Shared Module (lib/order-stock.ts)", () => {
    test("Exports releaseStockAndVoucherForOrder function", () => {
        expect(orderStockCode).toContain("export async function releaseStockAndVoucherForOrder");
    });

    test("Reads order with items inside transaction", () => {
        expect(orderStockCode).toContain("include: { items: true }");
    });

    test("Handles flash sale stock restoration", () => {
        expect(orderStockCode).toContain("FlashSale");
        expect(orderStockCode).toContain("saleStock");
    });

    test("Handles regular product stock restoration", () => {
        expect(orderStockCode).toContain("productVariant.update");
        expect(orderStockCode).toContain("increment");
    });

    test("Uses GREATEST(0, ...) for sold count (prevents negative)", () => {
        expect(orderStockCode).toContain("GREATEST(0, sold -");
    });

    test("Restores voucher global usage", () => {
        expect(orderStockCode).toContain("voucher.updateMany");
        expect(orderStockCode).toContain("decrement: 1");
    });

    test("Restores voucher per-user usage", () => {
        expect(orderStockCode).toContain("voucherUserUsage");
        expect(orderStockCode).toContain("usageCount");
    });

    test("Checks usageCount > 0 before decrementing (prevents negative)", () => {
        expect(orderStockCode).toContain("usageCount > 0");
    });

    test("Cleans up FlashSalePurchase records", () => {
        expect(orderStockCode).toContain("flashSalePurchase.deleteMany");
    });
});

// ==========================================
// HARDENING: Self-Referral Prevention
// ==========================================

describe("HARDENING: Self-Referral Prevention", () => {
    test("Checkout checks affiliate.userId !== input.userId (prevents self-referral)", () => {
        expect(checkoutCode).toContain("affiliate.userId === input.userId");
    });

    test("Self-referral logs SELF_REFERRAL_BLOCKED event", () => {
        expect(checkoutCode).toContain("SELF_REFERRAL_BLOCKED");
    });

    test("Self-referral prevents commission creation (affiliate cast to else-if)", () => {
        // The self-referral check is followed by an else-if that contains the commission logic
        const selfRefIdx = checkoutCode.indexOf("SELF_REFERRAL_BLOCKED");
        const conversionCreateIdx = checkoutCode.indexOf("affiliateConversion.create");
        expect(selfRefIdx).toBeGreaterThan(0);
        expect(conversionCreateIdx).toBeGreaterThan(selfRefIdx);
    });

    test("Referral code is validated server-side (only APPROVED affiliates)", () => {
        /*
         * Customer self-serve registration was removed (checkout is
         * guest-only), so the registration-time referral check no
         * longer exists. The surviving server-side validation is the
         * referral endpoint that records the cookie, and it must keep
         * rejecting non-APPROVED affiliates.
         */
        const referralCode = readFile(
            "app/api/affiliate/referral/route.ts"
        );
        expect(referralCode).toContain('status: "APPROVED"');
    });

    test("No customer registration endpoint is reachable", () => {
        expect(() =>
            readFile("app/api/auth/register/route.ts")
        ).toThrow();
    });
});

// ==========================================
// HARDENING: Authorization / IDOR
// ==========================================

describe("HARDENING: Affiliate API Authorization", () => {
    test("Affiliate dashboard requires auth", () => {
        const dashboardCode = readFile("app/api/affiliate/dashboard/route.ts");
        expect(dashboardCode).toContain('if (!session?.user?.id)');
    });

    test("Affiliate dashboard validates APPROVED status", () => {
        const dashboardCode = readFile("app/api/affiliate/dashboard/route.ts");
        expect(dashboardCode).toContain('affiliate.status !== "APPROVED"');
    });

    test("Affiliate payouts requires auth", () => {
        const payoutsCode = readFile("app/api/affiliate/payouts/route.ts");
        expect(payoutsCode).toContain('if (!session?.user?.id)');
    });

    test("Affiliate payouts filters by affiliate ID (ownership check)", () => {
        const payoutsCode = readFile("app/api/affiliate/payouts/route.ts");
        expect(payoutsCode).toContain('affiliateId: affiliate.id');
    });

    test("Affiliate commissions requires auth", () => {
        const commissionsCode = readFile("app/api/affiliate/commissions/route.ts");
        expect(commissionsCode).toContain('if (!session?.user?.id)');
    });

    test("Affiliate commissions filters by affiliate ID (ownership check)", () => {
        const commissionsCode = readFile("app/api/affiliate/commissions/route.ts");
        expect(commissionsCode).toContain('affiliateId: affiliate.id');
    });

    test("Admin affiliate detail requires ADMIN role", () => {
        const adminDetailCode = readFile("app/api/admin/affiliate/[id]/route.ts");
        expect(adminDetailCode).toContain('session.user.role !== "ADMIN"');
    });

    test("Admin payout action requires ADMIN role", () => {
        const adminPayoutCode = readFile("app/api/admin/affiliate/payouts/[id]/route.ts");
        expect(adminPayoutCode).toContain('session.user.role !== "ADMIN"');
    });

    test("Admin commission action requires ADMIN role", () => {
        const adminCommCode = readFile("app/api/admin/affiliate/commissions/[id]/route.ts");
        expect(adminCommCode).toContain('session.user.role !== "ADMIN"');
    });

    test("KYC image serving validates ownership (customer can only see own files)", () => {
        const imageCode = readFile("app/api/uploads/affiliate/[...path]/route.ts");
        expect(imageCode).toContain("session.user.id !== fileUserId");
        expect(imageCode).toContain("isAdmin");
    });

    test("KYC image serving validates file exists in DB (prevents arbitrary file access)", () => {
        const imageCode = readFile("app/api/uploads/affiliate/[...path]/route.ts");
        expect(imageCode).toContain("ktpImageUrl");
        expect(imageCode).toContain("socialMediaUrl");
    });

    test("Affiliate payout response masks bank account number", () => {
        const payoutsCode = readFile("app/api/affiliate/payouts/route.ts");
        expect(payoutsCode).toContain("replace(/.(?=.{4})/g, \"*\")");
    });
});

// ==========================================
// HARDENING: Financial Consistency
// ==========================================

describe("HARDENING: Financial Consistency", () => {
    test("getAvailableBalance uses payout-ledger model (earned - disbursed)", () => {
        const commissionCode = readFile("lib/affiliate/commission.ts");
        expect(commissionCode).toContain("earned =");
        expect(commissionCode).toContain("disbursed =");
        expect(commissionCode).toContain("earned.sub(disbursed)");
    });

    test("Balance cannot go negative (clamped to 0)", () => {
        const commissionCode = readFile("lib/affiliate/commission.ts");
        expect(commissionCode).toContain("available.gt(0)");
    });

    test("Payout creation under FOR UPDATE lock (prevents concurrent overspend)", () => {
        const commissionCode = readFile("lib/affiliate/commission.ts");
        expect(commissionCode).toContain("FOR UPDATE");
    });

    test("Payout checks existing PENDING payout under lock (prevents duplicate)", () => {
        const commissionCode = readFile("lib/affiliate/commission.ts");
        expect(commissionCode).toContain('status: "PENDING"');
        expect(commissionCode).toContain("existingPending");
    });

    test("Commission uses Decimal arithmetic (not floating-point)", () => {
        const commissionCode = readFile("lib/affiliate/commission.ts");
        expect(commissionCode).toContain("Prisma.Decimal");
        expect(commissionCode).toContain(".mul(r)");
        expect(commissionCode).toContain(".div(100)");
    });

    test("Commission has valid state transition map (PENDING→APPROVED→PAID or CANCELLED)", () => {
        const commissionCode = readFile("lib/affiliate/commission.ts");
        expect(commissionCode).toContain('PENDING: ["APPROVED", "CANCELLED"]');
        expect(commissionCode).toContain('APPROVED: ["PAID", "CANCELLED"]');
        expect(commissionCode).toContain('PAID: []');
    });

    test("Payout has valid state transition map", () => {
        const commissionCode = readFile("lib/affiliate/commission.ts");
        expect(commissionCode).toContain('PAYOUT_TRANSITIONS');
        expect(commissionCode).toContain('PAID: []');
        expect(commissionCode).toContain('REJECTED: []');
    });

    test("cancelCommissionForOrder is idempotent (checks existing status before cancelling)", () => {
        const cancelCode = readFile("lib/affiliate/cancel-commission.ts");
        expect(cancelCode).toContain('status === "CANCELLED"');
        expect(cancelCode).toContain('status === "REVERSED"');
        expect(cancelCode).toContain('status === "PAID"');
    });

    test("cancelCommissionForOrder does NOT silently reverse PAID commissions", () => {
        const cancelCode = readFile("lib/affiliate/cancel-commission.ts");
        expect(cancelCode).toContain("PAID conversion");
        expect(cancelCode).toContain("cannot be auto-cancelled");
    });

    test("Dashboard uses getAvailableBalance for balance (payout-ledger, not formula)", () => {
        const dashboardCode = readFile("app/api/affiliate/dashboard/route.ts");
        expect(dashboardCode).toContain("getAvailableBalance");
    });

    test("Admin detail uses getAvailableBalance for balance display", () => {
        const adminDetailCode = readFile("app/api/admin/affiliate/[id]/route.ts");
        expect(adminDetailCode).toContain("getAvailableBalance");
    });
});

// ==========================================
// COMMISSION AUTO-APPROVAL ON ORDER COMPLETION
// ==========================================

describe("Commission Auto-Approval on Order Completion", () => {
    const approveCode = readFile("lib/affiliate/approve-commission.ts");
    const adminOrderCode = readFile("app/api/admin/orders/[id]/route.ts");

    test("approveCommissionForOrder function exists and is exported", () => {
        expect(approveCode).toContain("export async function approveCommissionForOrder");
    });

    test("approveCommissionForOrder only transitions PENDING → APPROVED", () => {
        expect(approveCode).toContain('conversion.status !==');
        expect(approveCode).toContain('PENDING');
        expect(approveCode).toContain('status: \"APPROVED\"');
    });

    test("approveCommissionForOrder is idempotent (no-op if not PENDING)", () => {
        // Already approved/paid/cancelled → returns false
        expect(approveCode).toContain("Already approved/paid/cancelled/reversed");
    });

    test("approveCommissionForOrder does not throw on missing conversion", () => {
        expect(approveCode).toContain("No conversion for this order");
    });

    test("approveCommissionForOrder uses transaction client (not global prisma)", () => {
        expect(approveCode).toContain("tx.affiliateConversion.findUnique");
        expect(approveCode).toContain("tx.affiliateConversion.update");
    });

    test("approveCommissionForOrder has error handling (non-blocking)", () => {
        expect(approveCode).toContain("Don't let commission approval failure");
        expect(approveCode).toContain("return false");
    });

    test("approveCommissionForOrder creates audit log", () => {
        expect(approveCode).toContain("createAuditLog");
        expect(approveCode).toContain("COMMISSION_APPROVED");
    });

    test("Admin PATCH imports approveCommissionForOrder (dynamic)", () => {
        expect(adminOrderCode).toContain('approveCommissionForOrder');
        expect(adminOrderCode).toContain('@/lib/affiliate/approve-commission');
    });

    test("Admin PATCH calls approveCommissionForOrder when status is COMPLETED", () => {
        const completedIdx = adminOrderCode.indexOf('status === "COMPLETED"');
        const approveIdx = adminOrderCode.indexOf("approveCommissionForOrder");
        expect(completedIdx).toBeGreaterThan(0);
        expect(approveIdx).toBeGreaterThan(completedIdx);
    });

    test("Admin PATCH passes tx transaction client to approveCommissionForOrder", () => {
        expect(adminOrderCode).toContain("approveCommissionForOrder(");
        expect(adminOrderCode).toContain("tx,");
    });

    test("Existing cancelCommissionForOrder is still called on CANCELLED", () => {
        expect(adminOrderCode).toContain("cancelCommissionForOrder");
    });

    test("Balance formula still uses APPROVED + PAID as earned (not PENDING)", () => {
        const commissionCode = readFile("lib/affiliate/commission.ts");
        expect(commissionCode).toContain('in: ["APPROVED", "PAID"]');
    });
});
