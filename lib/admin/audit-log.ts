import { prisma } from "@/lib/prisma";

/* ==========================================
 * ADMIN AUDIT LOG
 * ==========================================
 *
 * Persistent audit trail for all admin actions.
 * Stores action, entity type/id, description,
 * and optional metadata (JSON).
 *
 * NEVER stores: passwords, tokens, KTP binary,
 * full bank account numbers, secrets.
 */

export type AuditAction =
    // Affiliate
    | "AFFILIATE_APPROVED"
    | "AFFILIATE_REJECTED"
    | "AFFILIATE_SUSPENDED"
    | "AFFILIATE_RATE_UPDATED"
    // Commission
    | "COMMISSION_APPROVED"
    | "COMMISSION_CANCELLED"
    | "COMMISSION_PAID"
    | "COMMISSION_BULK_APPROVED"
    | "COMMISSION_BULK_CANCELLED"
    // Payout
    | "PAYOUT_APPROVED"
    | "PAYOUT_REJECTED"
    | "PAYOUT_PAID"
    | "PAYOUT_SETTLE_RETRY"
    | "PAYOUT_PROCESSING"
    | "PAYOUT_FAILED"
    | "PAYOUT_WEBHOOK"
    | "PAYOUT_RECONCILE"
    | "PAYMENT_PROOF_UPLOADED"
    | "PAYMENT_CONFIRMED"
    // Order
    | "ORDER_STATUS_CHANGED"
    | "ORDER_CANCELLED"
    | "ORDER_REFUNDED"
    | "ORDER_TRACKING_ASSIGNED"
    // Refund
    | "REFUND_REQUESTED"
    | "REFUND_APPROVED"
    | "REFUND_COMPLETED"
    | "REFUND_FAILED"
    | "REFUND_PROOF_UPLOADED"
    // Repayment
    | "REPAYMENT_INITIATED"
    // Settings
    | "TIKTOK_PIXEL_UPDATED"
    // System
    | "AFFILIATE_COMMISSION_AUTO_CANCELLED";

export type EntityType =
    | "AffiliateProfile"
    | "AffiliateConversion"
    | "AffiliatePayout"
    | "Order"
    | "Refund"
    | "StoreSetting"
    | "System";

interface AuditLogParams {
    adminId: string;
    action: AuditAction;
    entityType: EntityType;
    entityId?: number;
    description: string;
    metadata?: Record<string, any>;
}

/**
 * Create an audit log entry.
 * Fire-and-forget: errors are logged but don't
 * throw (audit failures shouldn't block admin actions).
 */
export async function createAuditLog(
    params: AuditLogParams
): Promise<void> {
    try {
        // Sanitize metadata — remove sensitive fields
        const sanitized = params.metadata
            ? sanitizeMetadata(params.metadata)
            : undefined;

        await prisma.adminAuditLog.create({
            data: {
                adminId: params.adminId,
                action: params.action,
                entityType: params.entityType,
                entityId: params.entityId ?? null,
                description: params.description,
                ...(sanitized ? { metadata: sanitized as any } : {}),
            },
        });
    } catch (error) {
        // Don't let audit log failure break the admin action
        console.error("AUDIT_LOG_ERROR:", error);
    }
}

/**
 * Remove sensitive fields from metadata before storage.
 */
function sanitizeMetadata(
    meta: Record<string, any>
): Record<string, any> {
    const sanitized = { ...meta };

    // Mask bank account numbers (any key ending in
    // AccountNumber or accountNumber)
    for (const key of Object.keys(sanitized)) {
        if (/accountnumber$/i.test(key)) {
            const value = sanitized[key];
            if (
                typeof value === "string" &&
                value.length > 4
            ) {
                sanitized[key] =
                    "****" + value.slice(-4);
            }
        }
    }

    // Remove sensitive fields
    delete sanitized.password;
    delete sanitized.token;
    delete sanitized.secret;
    delete sanitized.cookie;
    delete sanitized.ktpImageBase64;

    return sanitized;
}

/**
 * Query audit logs with pagination.
 */
export async function getAuditLogs(params: {
    page?: number;
    limit?: number;
    entityType?: string;
    entityId?: number;
    adminId?: string;
    action?: string;
}) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(
        100,
        Math.max(1, params.limit || 20)
    );

    const where: any = {};
    if (params.entityType)
        where.entityType = params.entityType;
    if (params.entityId)
        where.entityId = params.entityId;
    if (params.adminId)
        where.adminId = params.adminId;
    if (params.action)
        where.action = params.action;

    const [items, total] = await Promise.all([
        prisma.adminAuditLog.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.adminAuditLog.count({ where }),
    ]);

    return {
        items,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}
