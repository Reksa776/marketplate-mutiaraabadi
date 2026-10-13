import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateCommissionRate } from "@/lib/affiliate/commission";
import { buildChartData } from "@/lib/affiliate/chart";
import { createAuditLog, getAuditLogs } from "@/lib/admin/audit-log";

type RouteContext = {
    params: Promise<{ id: string }>;
};

/* ==========================================
 * GET /api/admin/affiliate/[id]
 * ==========================================
 *
 * Affiliate detail with full performance
 * stats, commission breakdown, and
 * conversion history.
 */

export async function GET(req: Request, { params }: RouteContext) {
    try {
        const session = await auth();
        if (!session?.user?.id) {
            return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
        }
        if (session.user.role !== "ADMIN") {
            return NextResponse.json({ success: false, message: "Forbidden." }, { status: 403 });
        }

        const { id } = await params;
        const affiliateId = Number(id);
        if (!Number.isInteger(affiliateId) || affiliateId <= 0) {
            return NextResponse.json({ success: false, message: "ID tidak valid." }, { status: 400 });
        }

        const affiliate = await prisma.affiliateProfile.findUnique({
            where: { id: affiliateId },
            include: {
                user: { select: { id: true, name: true, email: true, phone: true } },
                kyc: { select: { bankName: true, bankAccountName: true, bankAccountNumber: true, socialMediaPlatform: true, socialMediaUsername: true, socialMediaUrl: true, ktpImageUrl: true } },
            },
        });

        if (!affiliate) {
            return NextResponse.json({ success: false, message: "Affiliate tidak ditemukan." }, { status: 404 });
        }

        // Chart: clicks grouped by day (raw SQL)
        // P0 FIX (C5/F1): was $queryRawUnsafe with PostgreSQL syntax
        // (double-quoted identifiers, INTERVAL '90 days') which fails
        // on MariaDB. Now: parameterized tagged template with
        // MariaDB backtick quoting + DATE_SUB — same pattern as
        // app/api/affiliate/dashboard/route.ts.
        const chartClicks = await prisma.$queryRaw<Array<{ date: Date; count: bigint }>>(
            Prisma.sql`
                SELECT DATE(cl.\`createdAt\`) as date, COUNT(*) as count
                FROM \`affiliateclick\` cl
                WHERE cl.\`affiliateId\` = ${affiliateId}
                  AND cl.\`createdAt\` >= DATE_SUB(NOW(), INTERVAL 90 DAY)
                GROUP BY DATE(cl.\`createdAt\`)
                ORDER BY date ASC
            `
        );

        // Chart: conversions grouped by day (raw SQL, MariaDB-compatible)
        const chartConversions = await prisma.$queryRaw<Array<{ date: Date; count: bigint; sales: string; commission: string }>>(
            Prisma.sql`
                SELECT DATE(c.\`createdAt\`) as date,
                       COUNT(*) as count,
                       COALESCE(SUM(c.\`orderSubtotal\`), 0) as sales,
                       COALESCE(SUM(c.\`commissionAmount\`), 0) as commission
                FROM \`affiliateconversion\` c
                WHERE c.\`affiliateId\` = ${affiliateId}
                  AND c.\`createdAt\` >= DATE_SUB(NOW(), INTERVAL 90 DAY)
                GROUP BY DATE(c.\`createdAt\`)
                ORDER BY date ASC
            `
        );

        // Performance stats
        const [clicks, orders, approvedPaid, pendingConv, approvedConv, paidConv, cancelledConv, monthlySales] = await Promise.all([
            prisma.affiliateClick.count({ where: { affiliateId } }),
            prisma.affiliateConversion.count({ where: { affiliateId } }),
            prisma.affiliateConversion.count({ where: { affiliateId, status: { in: ["APPROVED", "PAID"] } } }),
            prisma.affiliateConversion.aggregate({ where: { affiliateId, status: "PENDING" }, _sum: { commissionAmount: true, orderSubtotal: true }, _count: true }),
            prisma.affiliateConversion.aggregate({ where: { affiliateId, status: "APPROVED" }, _sum: { commissionAmount: true, orderSubtotal: true }, _count: true }),
            prisma.affiliateConversion.aggregate({ where: { affiliateId, status: "PAID" }, _sum: { commissionAmount: true, orderSubtotal: true }, _count: true }),
            prisma.affiliateConversion.aggregate({ where: { affiliateId, status: { in: ["CANCELLED", "REVERSED"] } }, _sum: { commissionAmount: true, orderSubtotal: true }, _count: true }),
            prisma.affiliateConversion.aggregate({ where: { affiliateId, createdAt: { gte: new Date(Date.now() - 30 * 86400000) } }, _sum: { orderSubtotal: true } }),
        ]);

        const totalSales = Number(pendingConv._sum.orderSubtotal ?? 0) + Number(approvedConv._sum.orderSubtotal ?? 0) + Number(paidConv._sum.orderSubtotal ?? 0);
        const totalCommission = Number(pendingConv._sum.commissionAmount ?? 0) + Number(approvedConv._sum.commissionAmount ?? 0) + Number(paidConv._sum.commissionAmount ?? 0);
        const conversionRate = clicks > 0 ? Number(((approvedPaid / clicks) * 100).toFixed(2)) : 0;
        const avgOrderValue = approvedPaid > 0 ? Math.round(totalSales / approvedPaid) : 0;

        // Recent conversions (latest 50)
        const recentConversions = await prisma.affiliateConversion.findMany({
            where: { affiliateId },
            orderBy: { createdAt: "desc" },
            take: 50,
            include: {
                order: { select: { orderNumber: true, createdAt: true } },
            },
        });

                // Pending payouts
                const pendingPayouts = await prisma.affiliatePayout.findMany({
                    where: { affiliateId, status: { in: ["PENDING", "PROCESSING"] } },
                    orderBy: { requestedAt: "desc" },
                });

        // All payouts (admin full history)
        const allPayouts = await prisma.affiliatePayout.findMany({
            where: { affiliateId },
            orderBy: { requestedAt: "desc" },
            take: 50,
        });

        // Available balance (payout-ledger based)
        const { getAvailableBalance } = await import("@/lib/affiliate/commission");
        const availableBalance = await getAvailableBalance(affiliateId);

        return NextResponse.json({
            success: true,
            data: {
                profile: {
                    id: affiliate.id,
                    name: affiliate.user?.name ?? "-",
                    email: affiliate.user?.email ?? "-",
                    phone: affiliate.user?.phone ?? "-",
                    affiliateCode: affiliate.affiliateCode,
                    commissionRate: Number(affiliate.commissionRate),
                    status: affiliate.status,
                    approvedAt: affiliate.approvedAt?.toISOString() ?? null,
                    bankName: affiliate.kyc?.bankName ?? "-",
                    bankAccountName: affiliate.kyc?.bankAccountName ?? "-",
                    bankAccountNumber: affiliate.kyc?.bankAccountNumber ?? "-",
                    socialMediaPlatform: affiliate.kyc?.socialMediaPlatform ?? null,
                    socialMediaUsername: affiliate.kyc?.socialMediaUsername ?? null,
                    socialMediaUrl: affiliate.kyc?.socialMediaUrl ?? null,
                    ktpImageUrl: affiliate.kyc?.ktpImageUrl ?? null,
                },
                stats: {
                    clicks,
                    orders,
                    conversions: approvedPaid,
                    totalSales,
                    totalCommission,
                    conversionRate,
                    averageOrderValue: avgOrderValue,
                    monthlySales: Number(monthlySales._sum.orderSubtotal ?? 0),
                },
                commission: {
                    pending: { count: pendingConv._count, amount: Number(pendingConv._sum.commissionAmount ?? 0), sales: Number(pendingConv._sum.orderSubtotal ?? 0) },
                    approved: { count: approvedConv._count, amount: Number(approvedConv._sum.commissionAmount ?? 0), sales: Number(approvedConv._sum.orderSubtotal ?? 0) },
                    paid: { count: paidConv._count, amount: Number(paidConv._sum.commissionAmount ?? 0), sales: Number(paidConv._sum.orderSubtotal ?? 0) },
                    cancelled: { count: cancelledConv._count, amount: Number(cancelledConv._sum.commissionAmount ?? 0), sales: Number(cancelledConv._sum.orderSubtotal ?? 0) },
                    total: totalCommission,
                },
                conversions: recentConversions.map((c) => ({
                    id: c.id,
                    orderNumber: c.order.orderNumber,
                    orderDate: c.order.createdAt.toISOString(),
                    orderSubtotal: Number(c.orderSubtotal),
                    commissionRate: Number(c.commissionRate),
                    commissionAmount: Number(c.commissionAmount),
                    status: c.status,
                    createdAt: c.createdAt.toISOString(),
                })),
                balance: {
                    available: availableBalance.toNumber(),
                    pending: Number(pendingConv._sum.commissionAmount ?? 0),
                    approved: Number(approvedConv._sum.commissionAmount ?? 0),
                    paid: Number(paidConv._sum.commissionAmount ?? 0),
                    totalEarned: totalCommission,
                },
                allPayouts: allPayouts.map((p) => ({
                    id: p.id,
                    amount: Number(p.amount),
                    status: p.status,
                    bankName: p.bankName,
                    bankAccountName: p.bankAccountName,
                    bankAccountNumber: p.bankAccountNumber,
                    requestedAt: p.requestedAt.toISOString(),
                    processedAt: p.processedAt?.toISOString() ?? null,
                    processedBy: p.processedBy ?? null,
                    rejectionReason: p.rejectionReason ?? null,
                })),
                pendingPayouts: pendingPayouts.map((p) => ({
                    id: p.id,
                    amount: Number(p.amount),
                    status: p.status,
                    requestedAt: p.requestedAt.toISOString(),
                })),
                chart: buildChartData(chartClicks, chartConversions, 90),
                auditLogs: (await getAuditLogs({
                    entityType: "AffiliateProfile",
                    entityId: affiliateId,
                    limit: 20,
                })).items.map((log) => ({
                    id: log.id,
                    adminId: log.adminId,
                    action: log.action,
                    description: log.description,
                    metadata: log.metadata,
                    createdAt: log.createdAt.toISOString(),
                })),
            },
        });
    } catch (error) {
        console.error("ADMIN AFFILIATE DETAIL ERROR:", error);
        return NextResponse.json({ success: false, message: "Gagal mengambil detail affiliate." }, { status: 500 });
    }
}

/* ==========================================
 * PATCH /api/admin/affiliate/[id]
 * ==========================================
 *
 * Admin actions on affiliate:
 *   - action: "UPDATE_RATE" → update commission rate
 *   - action: "UPDATE_STATUS" → change affiliate status
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
        const affiliateId = Number(id);
        if (!Number.isInteger(affiliateId) || affiliateId <= 0) {
            return NextResponse.json({ success: false, message: "ID tidak valid." }, { status: 400 });
        }

        const body = await req.json();
        const { action } = body;

        if (action === "UPDATE_RATE") {
            const { rate } = body;
            if (typeof rate !== "number" || rate < 0 || rate > 50) {
                return NextResponse.json({ success: false, message: "Rate harus antara 0% dan 50%." }, { status: 400 });
            }

            await updateCommissionRate(affiliateId, rate, session.user.id);

            await createAuditLog({
                adminId: session.user.id,
                action: "AFFILIATE_RATE_UPDATED",
                entityType: "AffiliateProfile",
                entityId: affiliateId,
                description: `Commission rate diubah ke ${rate}%`,
                metadata: { newRate: rate },
            });

            return NextResponse.json({ success: true, message: `Commission rate diubah ke ${rate}%.` });
        }

        if (action === "UPDATE_STATUS") {
            const { status } = body;
            const validStatuses = ["APPROVED", "REJECTED", "SUSPENDED"];
            if (!validStatuses.includes(status)) {
                return NextResponse.json({ success: false, message: "Status tidak valid." }, { status: 400 });
            }

            await prisma.affiliateProfile.update({
                where: { id: affiliateId },
                data: { status },
            });

            const auditAction = status === "APPROVED" ? "AFFILIATE_APPROVED" : status === "REJECTED" ? "AFFILIATE_REJECTED" : "AFFILIATE_SUSPENDED";
            await createAuditLog({
                adminId: session.user.id,
                action: auditAction,
                entityType: "AffiliateProfile",
                entityId: affiliateId,
                description: `Status affiliate diubah ke ${status}`,
                metadata: { newStatus: status },
            });

            return NextResponse.json({ success: true, message: `Status diubah ke ${status}.` });
        }

        return NextResponse.json({ success: false, message: "Action tidak valid." }, { status: 400 });
    } catch (error) {
        console.error("ADMIN AFFILIATE UPDATE ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Gagal update affiliate." },
            { status: 500 }
        );
    }
}

/*
 * The per-day chart (90-day window) is built by the shared, date-safe
 * `buildChartData` in lib/affiliate/chart.ts — see that module for the
 * `DATE()` value contract and the UTC-day bucket grid.
 */
