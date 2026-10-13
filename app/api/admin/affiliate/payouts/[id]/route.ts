import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isValidPayoutTransition, settleCommissionsForPayout } from "@/lib/affiliate/commission";
import { createDisbursement, getDisbursementStatus } from "@/lib/affiliate/payout-provider";
import { createAuditLog } from "@/lib/admin/audit-log";
import crypto from "crypto";

type RouteContext = {
    params: Promise<{ id: string }>;
};

/**
 * Raised when a concurrent admin request already moved the payout out of
 * the status this action requires. It is a CLIENT conflict, not a server
 * failure, so the route answers 409 instead of a 500 — the loser of a
 * double-approve must be told the truth (someone else already handled
 * it), not that the request blew up.
 *
 * Nothing financial happens on this path: the transaction that raises it
 * rolls back, and the winner's single settlement stands.
 */
class PayoutConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PayoutConflictError";
    }
}

/* ==========================================
 * PATCH /api/admin/affiliate/payouts/[id]
 * ==========================================
 *
 * Admin actions on payout:
 *   - action: "APPROVE" (PENDING → PROCESSING + call provider)
 *   - action: "REJECT" (PENDING → REJECTED) + reason
 *   - action: "CONFIRM_PAID" (PROCESSING → PAID, manual admin confirm)
 *   - action: "SETTLE" (retry commission settlement for PAID payouts)
 *   - action: "STATUS" (check provider status for PROCESSING payouts)
 *
 * PAID is ONLY set by:
 *   1. Provider webhook confirmation
 *   2. STATUS action when provider confirms SUCCESS
 *
 * NEVER set PAID directly from admin action.
 */

export async function PATCH(req: Request, { params }: RouteContext) {
    try {
        const session = await auth();
        if (!session?.user?.id) {
            return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
        }
        if (session.user.role !== "ADMIN") {
            return NextResponse.json({ success: false, message: "Forbidden." }, { status: 403 });
        }

        const { id } = await params;
        const payoutId = Number(id);
        if (!Number.isInteger(payoutId) || payoutId <= 0) {
            return NextResponse.json({ success: false, message: "ID tidak valid." }, { status: 400 });
        }

        const body = await req.json();
        const { action, reason } = body;

        // Find payout with full data
        const payout = await prisma.affiliatePayout.findUnique({
            where: { id: payoutId },
            select: {
                id: true,
                status: true,
                affiliateId: true,
                amount: true,
                bankName: true,
                bankAccountName: true,
                bankAccountNumber: true,
                providerTransactionId: true,
                providerReference: true,
                idempotencyKey: true,
                paidAt: true,
                failedAt: true,
            },
        });

        if (!payout) {
            return NextResponse.json({ success: false, message: "Payout tidak ditemukan." }, { status: 404 });
        }

        /* ==========================================
         * SETTLE: Retry commission settlement
         * ========================================== */

        if (action === "SETTLE") {
            if (payout.status !== "PAID") {
                return NextResponse.json({ success: false, message: "SETTLE hanya dapat dilakukan pada payout yang sudah PAID." }, { status: 400 });
            }

            const settledCount = await settleCommissionsForPayout(payoutId);

            await createAuditLog({
                adminId: session.user.id,
                action: "PAYOUT_SETTLE_RETRY",
                entityType: "AffiliatePayout",
                entityId: payoutId,
                description: `Manual settle retry: ${settledCount} conversion(s) settled`,
                metadata: { settledCount },
            });

            return NextResponse.json({
                success: true,
                message: `Settlement selesai: ${settledCount} conversion(s) diproses.`,
            });
        }

        /* ==========================================
         * STATUS: Check provider status
         * ==========================================
         *
         * For PROCESSING payouts, check with provider
         * if transfer actually succeeded.
         */

        if (action === "STATUS") {
            if (payout.status !== "PROCESSING") {
                return NextResponse.json({ success: false, message: "STATUS hanya dapat dilakukan pada payout yang PROCESSING." }, { status: 400 });
            }

            if (!payout.providerTransactionId && !payout.providerReference) {
                return NextResponse.json({ success: false, message: "Payout tidak memiliki provider reference." }, { status: 400 });
            }

            const statusResult = await getDisbursementStatus({
                providerTransactionId: payout.providerTransactionId || "",
                providerReference: payout.providerReference || undefined,
            });

            if (!statusResult.success) {
                return NextResponse.json({
                    success: false,
                    message: `Gagal mengecek status: ${statusResult.message}`,
                }, { status: 502 });
            }

            if (statusResult.status === "SUCCESS") {
                // Provider confirms success — finalize PAID
                await prisma.$transaction(async (tx) => {
                    const affectedRows = await tx.$executeRaw`
                        UPDATE affiliatepayout
                        SET status = 'PAID',
                            paidAt = IFNULL(paidAt, CURRENT_TIMESTAMP),
                            providerStatus = 'success'
                        WHERE id = ${payoutId}
                          AND status = 'PROCESSING'
                    `;

                    if (affectedRows === 0) {
                        return;
                    }

                    /*
                     * SETTLEMENT JOINS THIS TRANSACTION.
                     *
                     * The payout row is locked FOR UPDATE above, so
                     * opening a second transaction here (the helper's
                     * no-tx branch) would block forever on that lock and
                     * die as P2028 when the outer transaction expires.
                     * Passing `tx` keeps the CAS, the settlement and
                     * everything they touch in ONE atomic commit.
                     */
                    await settleCommissionsForPayout(
                        payoutId,
                        tx
                    );
                });

                await createAuditLog({
                    adminId: session.user.id,
                    action: "PAYOUT_PAID",
                    entityType: "AffiliatePayout",
                    entityId: payoutId,
                    description: `Payout confirmed via status check`,
                    metadata: { providerTransactionId: payout.providerTransactionId },
                });

                return NextResponse.json({
                    success: true,
                    message: "Payout berhasil dikonfirmasi sebagai PAID.",
                });
            }

            if (statusResult.status === "FAILED" || statusResult.status === "REJECTED") {
                /*
                 * CAS: prevent race if two STATUS checks
                 * run concurrently.
                 */
                const failStatus = statusResult.status === "REJECTED" ? "REJECTED" : "FAILED";

                await prisma.$transaction(async (tx) => {
                    const affectedRows = await tx.$executeRaw`
                        UPDATE affiliatepayout
                        SET status = ${failStatus},
                            failedAt = IFNULL(failedAt, CURRENT_TIMESTAMP),
                            failureReason = ${statusResult.message || `Provider status: ${failStatus}`},
                            providerStatus = ${failStatus.toLowerCase()}
                        WHERE id = ${payoutId}
                          AND status = 'PROCESSING'
                    `;

                    if (affectedRows === 0) {
                        return;
                    }

                    await createAuditLog({
                        adminId: session.user.id,
                        action: failStatus === "REJECTED" ? "PAYOUT_REJECTED" : "PAYOUT_FAILED",
                        entityType: "AffiliatePayout",
                        entityId: payoutId,
                        description: `Payout ${failStatus.toLowerCase()} per provider status`,
                        metadata: { message: statusResult.message },
                    });
                });

                return NextResponse.json({
                    success: false,
                    message: `Payout ${failStatus.toLowerCase()}: ${statusResult.message}`,
                });
            }

            return NextResponse.json({
                success: true,
                message: `Status: ${statusResult.status}. Masih diproses oleh provider.`,
            });
        }

        /* ==========================================
         * APPROVE: PENDING → PROCESSING + call provider
         * ==========================================
         *
         * This is the critical flow:
         * 1. Lock payout in transaction
         * 2. Validate state
         * 3. Mark PROCESSING
         * 4. Commit transaction
         * 5. Call provider OUTSIDE transaction
         * 6. If provider succeeds immediately → finalize PAID
         * 7. If provider async → wait for webhook
         */

        if (action === "APPROVE") {
            if (payout.status !== "PENDING") {
                return NextResponse.json({ success: false, message: `Transisi ${payout.status} → PROCESSING tidak valid.` }, { status: 400 });
            }

            // Validate affiliate is still valid
            const affiliate = await prisma.affiliateProfile.findUnique({
                where: { id: payout.affiliateId },
                select: { id: true, status: true },
            });

            if (!affiliate || affiliate.status !== "APPROVED") {
                return NextResponse.json({ success: false, message: "Affiliate tidak valid." }, { status: 400 });
            }

            // Generate idempotency key
            const idempotencyKey = `affiliate-payout-${payoutId}-${Date.now()}`;

            // Lock and transition: PENDING → PROCESSING
            await prisma.$transaction(async (tx) => {
                const locked = await tx.$queryRaw<Array<{ id: number; status: string }>>`
                    SELECT id, status FROM affiliatepayout
                    WHERE id = ${payoutId} AND status = 'PENDING'
                    FOR UPDATE
                `;

                if (!locked || locked.length === 0) {
                    throw new PayoutConflictError(
                        "Payout sudah tidak PENDING (concurrent edit)."
                    );
                }

                await tx.affiliatePayout.update({
                    where: { id: payoutId },
                    data: {
                        status: "PROCESSING",
                        processedAt: new Date(),
                        processedBy: session.user.id,
                        idempotencyKey,
                    },
                });
            });

            // Call provider OUTSIDE transaction
            const disbursementResult = await createDisbursement({
                payoutId,
                amount: Number(payout.amount),
                bankCode: payout.bankName,
                accountNumber: payout.bankAccountNumber,
                accountName: payout.bankAccountName,
                idempotencyKey,
                description: `Affiliate payout #${payoutId}`,
            });

            if (disbursementResult.success) {
                // Provider accepted — store reference
                await prisma.affiliatePayout.update({
                    where: { id: payoutId },
                    data: {
                        providerTransactionId:
                            disbursementResult.providerTransactionId || null,
                        providerReference:
                            disbursementResult.providerReference || null,
                        providerStatus:
                            disbursementResult.status || null,
                    },
                });

                // If provider returns SUCCESS synchronously
                if (disbursementResult.status === "SUCCESS") {
                    await prisma.$transaction(async (tx) => {
                        const affectedRows = await tx.$executeRaw`
                            UPDATE affiliatepayout
                            SET status = 'PAID',
                                paidAt = IFNULL(paidAt, CURRENT_TIMESTAMP),
                                providerStatus = 'success'
                            WHERE id = ${payoutId}
                              AND status = 'PROCESSING'
                        `;

                        if (affectedRows > 0) {
                            /*
                             * Settlement JOINS this transaction: the
                             * payout row is already locked FOR UPDATE by
                             * it, so the helper's no-tx branch (a second
                             * transaction) would self-block on that lock
                             * and fail as P2028. One commit keeps the
                             * PAID transition and the FIFO consumption
                             * atomic, which is what the ledger math
                             * (available = earned - disbursed) assumes.
                             */
                            await settleCommissionsForPayout(
                                payoutId,
                                tx
                            );
                        }
                    });

                    await createAuditLog({
                        adminId: session.user.id,
                        action: "PAYOUT_PAID",
                        entityType: "AffiliatePayout",
                        entityId: payoutId,
                        description: `Payout approved and confirmed by provider`,
                        metadata: {
                            providerTransactionId:
                                disbursementResult.providerTransactionId,
                            settled: true,
                        },
                    });

                    return NextResponse.json({
                        success: true,
                        message: "Payout berhasil diproses dan dikonfirmasi.",
                    });
                }

                // Async — wait for webhook
                await createAuditLog({
                    adminId: session.user.id,
                    action: "PAYOUT_PROCESSING",
                    entityType: "AffiliatePayout",
                    entityId: payoutId,
                    description: `Payout submitted to provider, awaiting confirmation`,
                    metadata: {
                        providerTransactionId:
                            disbursementResult.providerTransactionId,
                    },
                });

                return NextResponse.json({
                    success: true,
                    message: "Payout berhasil dikirim ke provider. Menunggu konfirmasi.",
                });
            }

            /*
             * Provider rejected or failed.
             *
             * FAILED/REJECTED from provider = definitive failure.
             *   → transition PROCESSING → FAILED (or REJECTED).
             *     Admin can see the reason and re-request.
             *
             * PENDING from provider = transient error
             *   (network timeout, 429 rate-limit, 5xx).
             *   → rollback to PENDING so admin can retry.
             */
            const isDefinitiveFailure =
                disbursementResult.status === "FAILED" ||
                disbursementResult.status === "REJECTED";

            const newFailStatus = isDefinitiveFailure
                ? (disbursementResult.status as "FAILED" | "REJECTED")
                : "PENDING";

            if (isDefinitiveFailure) {
                // PROCESSING → FAILED/REJECTED (definitive)
                await prisma.affiliatePayout.update({
                    where: { id: payoutId },
                    data: {
                        status: newFailStatus,
                        failedAt: new Date(),
                        providerStatus: disbursementResult.status?.toLowerCase() || "failed",
                        failureReason: disbursementResult.message || "Provider disbursement failed",
                    },
                });
            } else {
                // Transient — rollback to PENDING for retry
                await prisma.affiliatePayout.update({
                    where: { id: payoutId },
                    data: {
                        status: "PENDING",
                        processedAt: null,
                        processedBy: null,
                        idempotencyKey: null,
                        providerStatus: disbursementResult.status || "failed",
                        failureReason: disbursementResult.message || "Provider disbursement failed",
                    },
                });
            }

            await createAuditLog({
                adminId: session.user.id,
                action: "PAYOUT_FAILED",
                entityType: "AffiliatePayout",
                entityId: payoutId,
                description: isDefinitiveFailure
                    ? `Provider disbursement ${newFailStatus.toLowerCase()}: ${disbursementResult.message}`
                    : `Provider disbursement transient error, rolled back to PENDING`,
                metadata: { message: disbursementResult.message, status: disbursementResult.status },
            });

            return NextResponse.json({
                success: false,
                message: isDefinitiveFailure
                    ? `Provider menolak/ gagal: ${disbursementResult.message}`
                    : `Gagal mengirim ke provider (dapat dicoba ulang): ${disbursementResult.message}`,
            }, { status: 502 });
        }

        /* ==========================================
         * REJECT: PENDING → REJECTED
         * ========================================== */

        if (action === "REJECT") {
            if (payout.status !== "PENDING") {
                return NextResponse.json({ success: false, message: `Transisi ${payout.status} → REJECTED tidak valid.` }, { status: 400 });
            }

            if (!reason || !String(reason).trim()) {
                return NextResponse.json({ success: false, message: "Alasan penolakan wajib diisi." }, { status: 400 });
            }

            await prisma.affiliatePayout.update({
                where: { id: payoutId },
                data: {
                    status: "REJECTED",
                    processedAt: new Date(),
                    processedBy: session.user.id,
                    rejectionReason: String(reason).trim(),
                },
            });

            await createAuditLog({
                adminId: session.user.id,
                action: "PAYOUT_REJECTED",
                entityType: "AffiliatePayout",
                entityId: payoutId,
                description: `Payout rejected: ${String(reason).trim()}`,
                metadata: { reason: String(reason).trim() },
            });

            return NextResponse.json({
                success: true,
                message: "Payout ditolak.",
            });
        }

        /* ==========================================
         * CONFIRM_PAID: PROCESSING → PAID (manual)
         * ==========================================
         *
         * Manual admin confirmation that payment was
         * successful. Used when provider does not
         * provide automatic confirmation or for
         * manual bank transfers.
         *
         * IMPORTANT:
         * - This is NOT the same as APPROVE.
         * - APPROVE = approve request + send to provider.
         * - CONFIRM_PAID = confirm money was sent/received.
         * - Only works on PROCESSING payouts.
         * - CAS prevents double-confirmation.
         */

        if (action === "CONFIRM_PAID") {
            if (payout.status !== "PROCESSING") {
                return NextResponse.json({ success: false, message: `CONFIRM_PAID hanya dapat dilakukan pada payout yang PROCESSING.` }, { status: 400 });
            }

            const proofFilePath = body.proofFilePath || null;

            // CAS: PROCESSING → PAID (prevent double-confirm)
            await prisma.$transaction(async (tx) => {
                const affectedRows = await tx.$executeRaw`
                    UPDATE affiliatepayout
                    SET status = 'PAID',
                        paidAt = IFNULL(paidAt, CURRENT_TIMESTAMP),
                        proofFilePath = ${proofFilePath}
                    WHERE id = ${payoutId}
                      AND status = 'PROCESSING'
                `;

                if (affectedRows === 0) {
                    throw new PayoutConflictError(
                        "Payout sudah tidak PROCESSING (concurrent edit)."
                    );
                }

                /*
                 * Settlement JOINS this transaction (see the APPROVE
                 * path): the payout row is locked by it, so a nested
                 * transaction would self-block until the P2028 timeout.
                 */
                await settleCommissionsForPayout(payoutId, tx);
            });

            await createAuditLog({
                adminId: session.user.id,
                action: "PAYMENT_CONFIRMED",
                entityType: "AffiliatePayout",
                entityId: payoutId,
                description: `Payment manually confirmed by admin`,
                metadata: {
                    proofFilePath,
                    providerTransactionId: payout.providerTransactionId,
                    providerReference: payout.providerReference,
                },
            });

            return NextResponse.json({
                success: true,
                message: "Payout berhasil dikonfirmasi sebagai PAID.",
            });
        }

        /* ==========================================
         * UPLOAD_PROOF: Store proof file path
         * ==========================================
         *
         * Store payment proof file path on payout.
         * Does NOT change payout status.
         * Only for PAID or PROCESSING payouts.
         */

        if (action === "UPLOAD_PROOF") {
            if (payout.status !== "PROCESSING" && payout.status !== "PAID") {
                return NextResponse.json({ success: false, message: `UPLOAD_PROOF hanya dapat dilakukan pada payout PROCESSING atau PAID.` }, { status: 400 });
            }

            const proofPath = body.proofFilePath;
            if (!proofPath || typeof proofPath !== "string") {
                return NextResponse.json({ success: false, message: "proofFilePath wajib diisi." }, { status: 400 });

            }

            /* ==========================================
             * VALIDATE PROOF FILE PATH
             * ==========================================
             *
             * Prevent path traversal and arbitrary
             * filesystem access.
             */

            const cleanPath = proofPath.trim();

            // Must be a relative path within storage
            if (
                cleanPath.includes("..") ||
                cleanPath.startsWith("/") ||
                cleanPath.includes("\\") ||
                cleanPath.includes("\0") ||
                !cleanPath.startsWith("storage/uploads/")
            ) {
                return NextResponse.json(
                    { success: false, message: "Path bukti tidak valid." },
                    { status: 400 }
                );
            }

            // Must end with supported extension
            const validExtensions = [".jpg", ".jpeg", ".png", ".webp", ".pdf"];
            const ext = cleanPath.toLowerCase().substring(cleanPath.lastIndexOf("."));
            if (!validExtensions.includes(ext)) {
                return NextResponse.json(
                    { success: false, message: "Format file bukti tidak valid." },
                    { status: 400 }
                );
            }

            await prisma.affiliatePayout.update({
                where: { id: payoutId },
                data: { proofFilePath: proofPath },
            });

            await createAuditLog({
                adminId: session.user.id,
                action: "PAYMENT_PROOF_UPLOADED",
                entityType: "AffiliatePayout",
                entityId: payoutId,
                description: `Payment proof uploaded`,
                metadata: { proofFilePath: proofPath },
            });

            return NextResponse.json({
                success: true,
                message: "Bukti pembayaran berhasil disimpan.",
            });
        }

        return NextResponse.json({ success: false, message: "Action tidak valid." }, { status: 400 });
    } catch (error: any) {
        /*
         * A concurrent admin action that already moved the payout is a
         * 409 Conflict: the caller's action is no longer applicable and
         * the database is consistent (the transaction rolled back).
         */
        if (error instanceof PayoutConflictError) {
            console.warn(
                "ADMIN PAYOUT CONFLICT:",
                error.message
            );

            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Payout ini sudah diproses oleh admin lain. Muat ulang untuk melihat status terbaru.",
                },
                { status: 409 }
            );
        }

        console.error("ADMIN PAYOUT ACTION ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Gagal memproses payout." },
            { status: 500 }
        );
    }
}
