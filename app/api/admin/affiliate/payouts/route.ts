import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getDisbursementStatus } from "@/lib/affiliate/payout-provider";
import { settleCommissionsForPayout } from "@/lib/affiliate/commission";
import { createAuditLog } from "@/lib/admin/audit-log";

/* ==========================================
 * GET /api/admin/affiliate/payouts
 * ==========================================
 *
 * Admin list of all payout requests with
 * affiliate info and bank details.
 */

export async function GET(request: Request) {
    try {
        const session = await auth();
        if (!session?.user?.id) {
            return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
        }
        if (session.user.role !== "ADMIN") {
            return NextResponse.json({ success: false, message: "Forbidden." }, { status: 403 });
        }

        const { searchParams } = new URL(request.url);
        const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
        const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20")));
        const statusFilter = searchParams.get("status");
        const search = searchParams.get("search")?.trim();

        const where: any = {};
        if (statusFilter && statusFilter !== "ALL") {
            where.status = statusFilter;
        }
        if (search) {
            where.OR = [
                { affiliate: { affiliateCode: { contains: search } } },
                { affiliate: { user: { name: { contains: search } } } },
                { bankAccountNumber: { contains: search } },
            ];
        }

        const [payouts, total] = await Promise.all([
            prisma.affiliatePayout.findMany({
                where,
                orderBy: { requestedAt: "desc" },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    affiliate: {
                        include: {
                            user: { select: { name: true, email: true } },
                        },
                    },
                },
            }),
            prisma.affiliatePayout.count({ where }),
        ]);

        return NextResponse.json({
            success: true,
            data: {
                items: payouts.map((p) => ({
                    id: p.id,
                    affiliateId: p.affiliateId,
                    affiliateName: p.affiliate.user?.name ?? "-",
                    affiliateEmail: p.affiliate.user?.email ?? "-",
                    affiliateCode: p.affiliate.affiliateCode,
                    amount: Number(p.amount),
                    status: p.status,
                    bankName: p.bankName,
                    bankAccountName: p.bankAccountName,
                    bankAccountNumber: p.bankAccountNumber,
                    requestedAt: p.requestedAt.toISOString(),
                    processedAt: p.processedAt?.toISOString() ?? null,
                    processedBy: p.processedBy ?? null,
                    rejectionReason: p.rejectionReason ?? null,
                    createdAt: p.createdAt.toISOString(),
                })),
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (error) {
        console.error("ADMIN PAYOUTS LIST ERROR:", error);
        return NextResponse.json({ success: false, message: "Gagal mengambil data payout." }, { status: 500 });
    }
}

/* ==========================================
 * POST /api/admin/affiliate/payouts
 * ==========================================
 *
 * Reconcile all PROCESSING payouts against the
 * disbursement provider. Checks each payout's
 * status with the provider and transitions to
 * PAID/FAILED accordingly.
 *
 * This is the P1 reconciliation mechanism for
 * PROCESSING payouts whose webhooks never arrived.
 *
 * Idempotent: running multiple times is safe.
 */

export async function POST(request: Request) {
    try {
        const session = await auth();
        if (!session?.user?.id) {
            return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
        }
        if (session.user.role !== "ADMIN") {
            return NextResponse.json({ success: false, message: "Forbidden." }, { status: 403 });
        }

        const body = await request.json().catch(() => ({}));
        const payoutId = body.payoutId as number | undefined;

        // Find PROCESSING payouts to reconcile
        const where: any = { status: "PROCESSING" };
        if (payoutId) {
            where.id = payoutId;
        }

        const processingPayouts = await prisma.affiliatePayout.findMany({
            where,
            select: {
                id: true,
                affiliateId: true,
                amount: true,
                providerTransactionId: true,
                providerReference: true,
            },
        });

        if (processingPayouts.length === 0) {
            return NextResponse.json({
                success: true,
                message: "Tidak ada payout PROCESSING yang perlu direconcile.",
                data: { checked: 0, updated: 0 },
            });
        }

        let updated = 0;
        const results: Array<{ id: number; oldStatus: string; newStatus: string }> = [];

        for (const payout of processingPayouts) {
            if (!payout.providerTransactionId && !payout.providerReference) {
                // No provider reference — can't check status
                console.log(`[RECONCILE] Payout #${payout.id}: no provider reference, skipping`);
                continue;
            }

            try {
                const statusResult = await getDisbursementStatus({
                    providerTransactionId: payout.providerTransactionId || "",
                    providerReference: payout.providerReference || undefined,
                });

                if (!statusResult.success) {
                    console.log(`[RECONCILE] Payout #${payout.id}: provider check failed: ${statusResult.message}`);
                    continue;
                }

                if (statusResult.status === "SUCCESS") {
                    // CAS: PROCESSING → PAID
                    await prisma.$transaction(async (tx) => {
                        const affectedRows = await tx.$executeRaw`
                            UPDATE affiliatepayout
                            SET status = 'PAID',
                                paidAt = IFNULL(paidAt, CURRENT_TIMESTAMP),
                                providerStatus = 'success'
                            WHERE id = ${payout.id}
                              AND status = 'PROCESSING'
                        `;

                        if (affectedRows > 0) {
                            /*
                             * Settlement JOINS this transaction: the
                             * payout row is locked FOR UPDATE here, so a
                             * second transaction (the helper's no-tx
                             * branch) would self-block on that lock and
                             * die as P2028 — the same defect the admin
                             * APPROVE path had. Atomicity, locking and
                             * idempotency are unchanged: the CAS above
                             * still decides whether anything settles.
                             */
                            await settleCommissionsForPayout(
                                payout.id,
                                tx
                            );
                        }
                    });

                    results.push({ id: payout.id, oldStatus: "PROCESSING", newStatus: "PAID" });
                    updated++;
                } else if (statusResult.status === "FAILED" || statusResult.status === "REJECTED") {
                    // CAS: PROCESSING → FAILED/REJECTED
                    const failStatus = statusResult.status;
                    await prisma.$transaction(async (tx) => {
                        await tx.$executeRaw`
                            UPDATE affiliatepayout
                            SET status = ${failStatus},
                                failedAt = IFNULL(failedAt, CURRENT_TIMESTAMP),
                                failureReason = ${statusResult.message || `Reconciled: ${failStatus}`},
                                providerStatus = ${failStatus.toLowerCase()}
                            WHERE id = ${payout.id}
                              AND status = 'PROCESSING'
                        `;
                    });

                    results.push({ id: payout.id, oldStatus: "PROCESSING", newStatus: failStatus });
                    updated++;
                } else {
                    // PENDING/PROCESSING → stays PROCESSING
                    console.log(`[RECONCILE] Payout #${payout.id}: provider status ${statusResult.status}, still PROCESSING`);
                }
            } catch (err) {
                console.error(`[RECONCILE] Payout #${payout.id}: error checking status`, err);
            }
        }

        await createAuditLog({
            adminId: session.user.id,
            action: "PAYOUT_RECONCILE",
            entityType: "AffiliatePayout",
            description: `Reconciled ${processingPayouts.length} payout(s), ${updated} updated`,
            metadata: { checked: processingPayouts.length, updated, results },
        });

        return NextResponse.json({
            success: true,
            message: `Reconcile selesai: ${updated} dari ${processingPayouts.length} payout diperbarui.`,
            data: { checked: processingPayouts.length, updated, results },
        });
    } catch (error) {
        console.error("PAYOUT RECONCILE ERROR:", error);
        return NextResponse.json({ success: false, message: "Gagal reconcile payout." }, { status: 500 });
    }
}
