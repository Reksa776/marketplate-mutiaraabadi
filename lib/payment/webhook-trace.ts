/**
 * ==========================================================
 * UNMATCHED PAYMENT WEBHOOK TRACE
 * ==========================================================
 *
 * A provider callback (iPaymu / Midtrans) can arrive AFTER the order
 * row it refers to was legitimately deleted by an approved cleanup.
 * The old behavior was a log line plus HTTP 200 — the money would then
 * have no database trace at all.
 *
 * This helper writes one AdminAuditLog row (a table that is explicitly
 * PRESERVED by the cleanup) so finance can still reconcile a late
 * settlement against a real record.
 *
 * It deliberately does NOT:
 *   - create or update any order / payment status,
 *   - mark anything PAID,
 *   - call the provider,
 *   - store PII (no name / phone / email / bank account).
 *
 * `createAuditLog` already swallows its own errors, so a trace failure
 * never turns a webhook into a 500 (which would trigger provider
 * retries).
 */

import { createAuditLog } from "@/lib/admin/audit-log";

export type UnmatchedPaymentProvider = "ipaymu" | "midtrans";

export interface UnmatchedPaymentWebhook {
    provider: UnmatchedPaymentProvider;
    /** Provider-side order reference (our orderNumber, or the raw ref). */
    orderNumber: string;
    transactionStatus?: string | number | null;
    amount?: string | number | null;
    providerReference?: string | null;
    paymentType?: string | null;
}

export async function recordUnmatchedPaymentWebhook(
    input: UnmatchedPaymentWebhook
): Promise<void> {
    await createAuditLog({
        adminId: "SYSTEM",
        action: "PAYMENT_WEBHOOK_ORPHAN",
        entityType: "System",
        description:
            `Payment webhook ${input.provider} diterima untuk order yang tidak ditemukan ` +
            `(kemungkinan order sudah dibersihkan). Perlu rekonsiliasi manual.`,
        metadata: {
            provider: input.provider,
            orderNumber: input.orderNumber,
            transactionStatus: input.transactionStatus ?? null,
            amount: input.amount ?? null,
            providerReference: input.providerReference ?? null,
            paymentType: input.paymentType ?? null,
            recordedAt: new Date().toISOString(),
        },
    });
}
