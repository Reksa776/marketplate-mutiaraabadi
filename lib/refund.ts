import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

/* ==========================================
 * REFUND ELIGIBILITY
 * ==========================================
 *
 * Determines if an order is eligible for refund.
 *
 * Rules:
 * - Order must exist and belong to the user (for user requests)
 * - Order status must be PAID or PROCESSING
 * - Payment status must be PAID
 * - No existing pending refund
 * - Not already refunded
 *
 * Server-authoritative: all values from DB.
 */

export type RefundEligibility =
    | { eligible: true; orderTotal: Prisma.Decimal }
    | { eligible: false; reason: string };

const CANCELLABLE_STATUSES = ["PAID", "PROCESSING"];

export function checkRefundEligibility(
    orderStatus: string,
    paymentStatus: string,
    hasPendingRefund: boolean
): RefundEligibility {
    // Already refunded
    if (paymentStatus === "REFUNDED") {
        return {
            eligible: false,
            reason: "Pesanan sudah direfund.",
        };
    }

    // Pending refund already exists
    if (hasPendingRefund) {
        return {
            eligible: false,
            reason: "Permintaan refund sedang diproses.",
        };
    }

    // Must be PAID or PROCESSING
    if (!CANCELLABLE_STATUSES.includes(orderStatus)) {
        return {
            eligible: false,
            reason: `Pesanan dengan status ${orderStatus} tidak dapat direfund.`,
        };
    }

    // Payment must be PAID
    if (paymentStatus !== "PAID") {
        return {
            eligible: false,
            reason: "Pesanan belum dibayar.",
        };
    }

    return { eligible: true, orderTotal: new Prisma.Decimal(0) };
}

/* ==========================================
 * CREATE REFUND REQUEST
 * ==========================================
 *
 * User-initiated refund request.
 *
 * Security:
 * - Ownership check (userId matches)
 * - Server-side amount (order.total from DB)
 * - CAS on order status (REFUND_PENDING)
 * - Idempotent (unique orderId constraint on Refund)
 * - Rate limited by caller
 *
 * Must be called inside or outside transaction.
 * Creates its own transaction for atomicity.
 */

export type CreateRefundResult =
    | { ok: true; refundId: number }
    | { ok: false; reason: string };

export async function createRefundRequest(
    userId: string,
    orderId: number,
    reason?: string,
    bank?: {
        bankName?: string | null;
        bankAccountName?: string | null;
        bankAccountNumber?: string | null;
    }
): Promise<CreateRefundResult> {
    return prisma.$transaction(
        async (tx) => {
            // ==========================================
            // 1. FIND ORDER + OWNERSHIP CHECK
            // ==========================================

            const order = await tx.order.findFirst({
                where: {
                    id: orderId,
                    userId,
                },
                select: {
                    id: true,
                    status: true,
                    paymentStatus: true,
                    total: true,
                },
            });

            if (!order) {
                return {
                    ok: false,
                    reason: "Order tidak ditemukan.",
                };
            }

            // ==========================================
            // 2. ELIGIBILITY CHECK
            // ==========================================

            const existingRefund = await tx.refund.findUnique({
                where: { orderId },
                select: { id: true, status: true },
            });

            const eligibility = checkRefundEligibility(
                order.status,
                order.paymentStatus,
                !!existingRefund
            );

            if (!eligibility.eligible) {
                return {
                    ok: false,
                    reason: eligibility.reason,
                };
            }

            // ==========================================
            // 3. CREATE REFUND RECORD
            // ==========================================
            //
            // Amount is SERVER-AUTHORITATIVE: order.total from DB.
            // Client cannot influence the refund amount.

            const refund = await tx.refund.create({
                data: {
                    orderId,
                    amount: order.total,
                    reason: reason || null,
                    status: "PENDING",
                    requestedBy: userId,
                    bankName: bank?.bankName?.trim() || null,
                    bankAccountName:
                        bank?.bankAccountName?.trim() || null,
                    bankAccountNumber:
                        bank?.bankAccountNumber?.trim() || null,
                },
            });

            // ==========================================
            // 4. CAS: ORDER STATUS → REFUND_PENDING
            // ==========================================
            //
            // Only transition from PAID/PROCESSING.
            // Prevents:
            // - Double refund (already REFUND_PENDING)
            // - State resurrection (CANCELLED → REFUND_PENDING)
            // - Race condition (concurrent requests)

            const affectedRows = await tx.$executeRaw`
                UPDATE \`order\`
                SET status = 'REFUND_PENDING'
                WHERE id = ${orderId}
                  AND status IN ('PAID', 'PROCESSING')
                  AND paymentStatus = 'PAID'
            `;

            if (affectedRows === 0) {
                // CAS failed — refund record exists but order
                // state changed concurrently. Rollback refund.
                throw new Error(
                    "Status order berubah saat pemrosesan refund. Silakan coba lagi."
                );
            }

            // ==========================================
            // 5. AUDIT LOG
            // ==========================================

            try {
                const { createAuditLog } = await import(
                    "@/lib/admin/audit-log"
                );
                await createAuditLog({
                    adminId: userId,
                    action: "REFUND_REQUESTED",
                    entityType: "Refund",
                    entityId: refund.id,
                    description: `Refund requested: Rp ${order.total.toString()} for order ${orderId}`,
                    metadata: {
                        orderId,
                        amount: order.total.toString(),
                        reason: reason || null,
                    },
                });
            } catch {
                /* audit log failure is non-critical */
            }

            return { ok: true, refundId: refund.id };
        },
        {
            timeout: 15000,
            maxWait: 10000,
        }
    );
}

/* ==========================================
 * PROCESS REFUND (ADMIN)
 * ==========================================
 *
 * Admin approves and processes a refund.
 *
 * Security:
 * - Admin authorization (checked by caller)
 * - Server-side amount (refund.amount from DB)
 * - CAS on refund status (PENDING → PROCESSING → COMPLETED)
 * - Idempotent (status check prevents double processing)
 *
 * This function handles:
 * 1. Approve refund request
 * 2. Mark as PROCESSING
 * 3. After provider confirms → mark as COMPLETED
 * 4. Release stock + voucher + affiliate commission
 */

export type ProcessRefundResult =
    | { ok: true }
    | { ok: false; reason: string };

/**
 * Admin approves refund → sets status to PROCESSING.
 * Caller should then call provider refund API.
 */
export async function approveRefund(
    refundId: number,
    adminId: string
): Promise<ProcessRefundResult> {
    return prisma.$transaction(
        async (tx) => {
            const refund = await tx.refund.findUnique({
                where: { id: refundId },
                select: {
                    id: true,
                    orderId: true,
                    status: true,
                    amount: true,
                },
            });

            if (!refund) {
                return {
                    ok: false,
                    reason: "Refund tidak ditemukan.",
                };
            }

            if (refund.status !== "PENDING") {
                return {
                    ok: false,
                    reason: `Refund dengan status ${refund.status} tidak dapat diproses.`,
                };
            }

            // CAS: PENDING → PROCESSING
            const affectedRows = await tx.$executeRaw`
                UPDATE \`refund\`
                SET status = 'PROCESSING',
                    processedBy = ${adminId}
                WHERE id = ${refundId}
                  AND status = 'PENDING'
            `;

            if (affectedRows === 0) {
                return {
                    ok: false,
                    reason: "Refund sudah diproses oleh admin lain.",
                };
            }

            // Audit log
            try {
                const { createAuditLog } = await import(
                    "@/lib/admin/audit-log"
                );
                await createAuditLog({
                    adminId,
                    action: "REFUND_APPROVED",
                    entityType: "Refund",
                    entityId: refundId,
                    description: `Refund approved: Rp ${refund.amount.toString()} for order ${refund.orderId}`,
                    metadata: {
                        orderId: refund.orderId,
                        amount: refund.amount.toString(),
                    },
                });
            } catch {
                /* non-critical */
            }

            return { ok: true };
        },
        {
            timeout: 15000,
            maxWait: 10000,
        }
    );
}

/**
 * Mark refund as COMPLETED after provider confirms.
 * Releases stock, voucher, and cancels affiliate commission.
 *
 * Called from webhook handler or admin callback.
 */
/**
 * Shared refund completion logic.
 *
 * Used by:
 * - completeRefund() (admin endpoint)
 * - iPaymu webhook handler
 *
 * This is the CANONICAL refund completion implementation.
 * All refund completion paths MUST call this function.
 *
 * Performs:
 * 1. CAS: Refund PROCESSING → COMPLETED
 * 2. CAS: Order paymentStatus PAID → REFUNDED, status → CANCELLED
 * 3. Release stock + voucher
 * 4. Cancel affiliate commission
 * 5. Restore spin wheel reward
 * 6. Audit log
 *
 * Idempotent: duplicate calls return safe no-op.
 * Atomic: all operations inside a single transaction.
 */
export async function executeRefundCompletion(
    refundId: number,
    providerRef?: string,
    source: string = "ADMIN"
): Promise<ProcessRefundResult> {
    return prisma.$transaction(
        async (tx) => {
            const refund = await tx.refund.findUnique({
                where: { id: refundId },
                select: {
                    id: true,
                    orderId: true,
                    status: true,
                    amount: true,
                },
            });

            if (!refund) {
                return {
                    ok: false,
                    reason: "Refund tidak ditemukan.",
                };
            }

            if (refund.status === "COMPLETED") {
                // Idempotent — already completed
                return { ok: true };
            }

            if (refund.status !== "PROCESSING") {
                return {
                    ok: false,
                    reason: `Refund dengan status ${refund.status} tidak dapat diselesaikan.`,
                };
            }

            // ==========================================
            // 1. CAS: REFUND PROCESSING → COMPLETED
            // ==========================================

            const affectedRows = await tx.$executeRaw`
                UPDATE \`refund\`
                SET status = 'COMPLETED',
                    providerRef = COALESCE(${providerRef || null}, providerRef)
                WHERE id = ${refundId}
                  AND status = 'PROCESSING'
            `;

            if (affectedRows === 0) {
                return {
                    ok: false,
                    reason: "Refund sudah diselesaikan.",
                };
            }

            // ==========================================
            // 2. CAS: ORDER paymentStatus → REFUNDED,
            //         status → CANCELLED
            // ==========================================
            //
            // Only if currently PAID (prevents resurrection).
            // Transitions REFUND_PENDING → CANCELLED.
            // Other statuses remain unchanged.

            await tx.$executeRaw`
                UPDATE \`order\`
                SET paymentStatus = 'REFUNDED',
                    status = IF(status = 'REFUND_PENDING', 'CANCELLED', status)
                WHERE id = ${refund.orderId}
                  AND paymentStatus = 'PAID'
            `;

            // ==========================================
            // 3. RELEASE STOCK + VOUCHER
            // ==========================================

            const { releaseStockAndVoucherForOrder } = await import(
                "@/lib/order-stock"
            );
            await releaseStockAndVoucherForOrder(tx, refund.orderId);

            // ==========================================
            // 4. CANCEL AFFILIATE COMMISSION
            // ==========================================

            const { cancelCommissionForOrder } = await import(
                "@/lib/affiliate/cancel-commission"
            );
            await cancelCommissionForOrder(
                tx,
                refund.orderId,
                "ORDER_REFUNDED"
            );

            // ==========================================
            // 5. RESTORE SPIN WHEEL REWARD
            // ==========================================

            const spinRecord = await tx.spinWheelSpin.findUnique({
                where: { orderId: refund.orderId },
            });

            if (spinRecord) {
                await tx.spinWheelSpin.update({
                    where: { id: spinRecord.id },
                    data: {
                        status: "AVAILABLE",
                        usedAt: null,
                        orderId: null,
                    },
                });
            }

            // ==========================================
            // 6. AUDIT LOG
            // ==========================================

            try {
                const { createAuditLog } = await import(
                    "@/lib/admin/audit-log"
                );
                await createAuditLog({
                    adminId: source,
                    action: "REFUND_COMPLETED",
                    entityType: "Refund",
                    entityId: refundId,
                    description: `Refund completed (${source}): Rp ${refund.amount.toString()} for order ${refund.orderId}`,
                    metadata: {
                        orderId: refund.orderId,
                        amount: refund.amount.toString(),
                        providerRef: providerRef || null,
                        source,
                    },
                });
            } catch {
                /* non-critical */
            }

            return { ok: true };
        },
        {
            timeout: 15000,
            maxWait: 10000,
        }
    );
}

/**
 * Public API: Complete a refund (admin endpoint).
 * Delegates to executeRefundCompletion().
 */
export async function completeRefund(
    refundId: number,
    providerRef?: string
): Promise<ProcessRefundResult> {
    return executeRefundCompletion(refundId, providerRef, "ADMIN");
}

/**
 * Mark refund as FAILED if provider rejects it.
 */
export async function failRefund(
    refundId: number,
    failureReason?: string
): Promise<ProcessRefundResult> {
    return prisma.$transaction(
        async (tx) => {
            const refund = await tx.refund.findUnique({
                where: { id: refundId },
                select: {
                    id: true,
                    orderId: true,
                    status: true,
                },
            });

            if (!refund) {
                return {
                    ok: false,
                    reason: "Refund tidak ditemukan.",
                };
            }

            if (refund.status === "FAILED" || refund.status === "COMPLETED") {
                return { ok: true };
            }

            // CAS: PENDING/PROCESSING → FAILED
            const affectedRows = await tx.$executeRaw`
                UPDATE \`refund\`
                SET status = 'FAILED'
                WHERE id = ${refundId}
                  AND status IN ('PENDING', 'PROCESSING')
            `;

            if (affectedRows === 0) {
                return { ok: true };
            }

            // Revert order status from REFUND_PENDING back to PAID
            await tx.$executeRaw`
                UPDATE \`order\`
                SET status = 'PAID'
                WHERE id = ${refund.orderId}
                  AND status = 'REFUND_PENDING'
            `;

            // Audit log
            try {
                const { createAuditLog } = await import(
                    "@/lib/admin/audit-log"
                );
                await createAuditLog({
                    adminId: "SYSTEM",
                    action: "REFUND_FAILED",
                    entityType: "Refund",
                    entityId: refundId,
                    description: `Refund failed for order ${refund.orderId}: ${failureReason || "Provider rejected"}`,
                    metadata: {
                        orderId: refund.orderId,
                        failureReason: failureReason || null,
                    },
                });
            } catch {
                /* non-critical */
            }

            return { ok: true };
        },
        {
            timeout: 15000,
            maxWait: 10000,
        }
    );
}

/**
 * Find refund by order number (for webhook matching).
 */
export async function findRefundByOrderNumber(
    orderNumber: string
) {
    return prisma.refund.findFirst({
        where: {
            order: { orderNumber },
            status: { in: ["PENDING", "PROCESSING"] },
        },
        select: {
            id: true,
            orderId: true,
            status: true,
            amount: true,
        },
    });
}

/**
 * Find refund by order ID (for webhook matching).
 */
export async function findRefundByOrderId(orderId: number) {
    return prisma.refund.findFirst({
        where: {
            orderId,
            status: { in: ["PENDING", "PROCESSING"] },
        },
        select: {
            id: true,
            orderId: true,
            status: true,
            amount: true,
        },
    });
}

/* ==========================================
 * WEBHOOK REFUND TRANSITION
 * ==========================================
 *
 * CAS-protected transition for webhook refund processing.
 *
 * Used by payment webhook handlers.
 * Handles the case where a user-initiated refund is PENDING
 * and the provider confirms the refund before admin approval.
 *
 * CAS: PENDING → PROCESSING only if current status is PENDING.
 * If CAS fails (affectedRows = 0), re-read current status:
 *   - PROCESSING: admin already approved → proceed to completion
 *   - COMPLETED: already done → return ok
 *   - FAILED: admin rejected → return no-op
 *   - PENDING: impossible (CAS would have succeeded)
 *
 * @returns { status: string, shouldComplete: boolean }
 *   shouldComplete = true → caller should call executeRefundCompletion()
 *   shouldComplete = false → refund is terminal, caller should return ok
 */
export async function transitionRefundForWebhook(
    refundId: number,
    providerRef?: string
): Promise<{ status: string; shouldComplete: boolean }> {
    // CAS: PENDING → PROCESSING
    const affectedRows = await prisma.$executeRaw`
        UPDATE \`refund\`
        SET status = 'PROCESSING',
            processedBy = 'PROVIDER_AUTO',
            providerRef = COALESCE(${providerRef || null}, providerRef)
        WHERE id = ${refundId}
          AND status = 'PENDING'
    `;

    if (affectedRows > 0) {
        // CAS succeeded → now PROCESSING → proceed to completion
        return { status: "PROCESSING", shouldComplete: true };
    }

    // CAS failed → re-read current status
    const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        select: { status: true },
    });

    if (!refund) {
        return { status: "NOT_FOUND", shouldComplete: false };
    }

    switch (refund.status) {
        case "PROCESSING":
            // Admin already approved → proceed to completion
            return { status: "PROCESSING", shouldComplete: true };
        case "COMPLETED":
            // Already done → idempotent no-op
            return { status: "COMPLETED", shouldComplete: false };
        case "FAILED":
            // Admin rejected → do NOT complete
            return { status: "FAILED", shouldComplete: false };
        default:
            // Unknown state → do NOT complete
            return { status: refund.status, shouldComplete: false };
    }
}
