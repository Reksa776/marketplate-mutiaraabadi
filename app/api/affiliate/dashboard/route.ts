import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getAvailableBalance } from "@/lib/affiliate/commission";
import { buildChartData } from "@/lib/affiliate/chart";
import { Prisma } from "@prisma/client";

/* ==========================================
 * GET /api/affiliate/dashboard
 * ==========================================
 *
 * Returns comprehensive affiliate data:
 *   - Profile info (code, commission rate, status)
 *   - KPI stats with trend comparison
 *   - Conversion funnel
 *   - Commission breakdown by status
 *   - Time-series chart data (properly aggregated by day)
 *   - Paginated conversion history with search/filter
 *   - Recent activity feed
 *
 * Query params:
 *   - page, limit, search, status, days
 */

export async function GET(request: Request) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        const { searchParams } = new URL(
            request.url
        );
        const page = Math.max(
            1,
            parseInt(searchParams.get("page") || "1")
        );
        const limit = Math.min(
            50,
            Math.max(
                1,
                parseInt(
                    searchParams.get("limit") || "20"
                )
            )
        );
        const search = searchParams
            .get("search")
            ?.trim();
        const statusFilter = searchParams.get(
            "status"
        );
        const daysParam = searchParams.get("days");
        const days =
            daysParam && daysParam !== "all"
                ? parseInt(daysParam)
                : null;

        /* ==========================================
         * FIND AFFILIATE PROFILE
         * ========================================== */

        const affiliate =
            await prisma.affiliateProfile.findFirst({
                where: {
                    userId: session.user.id,
                },
                select: {
                    id: true,
                    affiliateCode: true,
                    commissionRate: true,
                    status: true,
                    approvedAt: true,
                },
            });

        if (
            !affiliate ||
            affiliate.status !== "APPROVED"
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Akun Anda belum menjadi affiliator.",
                },
                { status: 403 }
            );
        }

        const affiliateId = affiliate.id;

        /* ==========================================
         * DATE RANGES
         * ========================================== */

        const now = new Date();
        const dateFrom = days
            ? new Date(
                  now.getTime() -
                      days * 24 * 60 * 60 * 1000
              )
            : null;
        // Previous period for trend comparison
        const prevDateFrom = days
            ? new Date(
                  now.getTime() -
                      days * 2 * 24 * 60 * 60 * 1000
              )
            : null;
        const prevDateTo = dateFrom;

        /* ==========================================
         * BUILD DATE FILTERS FOR RAW SQL
         * ==========================================
         *
         * Prisma groupBy groups by exact timestamp.
         * We need raw SQL to GROUP BY DATE().
         */

        const dateFilterSql = dateFrom
            ? Prisma.sql`AND c.\`createdAt\` >= ${dateFrom.toISOString()}`
            : Prisma.empty;
        const clickDateFilterSql = dateFrom
            ? Prisma.sql`AND cl.\`createdAt\` >= ${dateFrom.toISOString()}`
            : Prisma.empty;

        /* ==========================================
         * PARALLEL QUERIES
         * ========================================== */

        const [
            // Current period stats
            totalClicks,
            totalOrders,
            totalConversions,
            pendingConversion,
            approvedConversion,
            paidConversion,
            cancelledConversion,
            periodClicks,

            // Previous period stats (for trends)
            prevTotalClicks,
            prevTotalConversions,
            prevTotalSales,
            prevTotalCommission,

            // Chart data (raw SQL for proper day grouping)
            chartClicks,
            chartConversions,

            // Monthly sales for earnings estimation
            monthlyConversions,

            // Balance data
            paidBalance,

            // Payout history
            recentPayouts,
        ] = await Promise.all([
            // Current: total clicks (all time)
            prisma.affiliateClick.count({
                where: { affiliateId },
            }),

            // Current: total orders
            prisma.affiliateConversion.count({
                where: { affiliateId },
            }),

            // Current: approved+paid conversions
            prisma.affiliateConversion.count({
                where: {
                    affiliateId,
                    status: {
                        in: ["APPROVED", "PAID"],
                    },
                },
            }),

            // Pending commission
            prisma.affiliateConversion.aggregate({
                where: {
                    affiliateId,
                    status: "PENDING",
                },
                _sum: {
                    commissionAmount: true,
                    orderSubtotal: true,
                },
                _count: true,
            }),

            // Approved commission
            prisma.affiliateConversion.aggregate({
                where: {
                    affiliateId,
                    status: "APPROVED",
                },
                _sum: {
                    commissionAmount: true,
                    orderSubtotal: true,
                },
                _count: true,
            }),

            // Paid commission
            prisma.affiliateConversion.aggregate({
                where: {
                    affiliateId,
                    status: "PAID",
                },
                _sum: {
                    commissionAmount: true,
                    orderSubtotal: true,
                },
                _count: true,
            }),

            // Cancelled commission
            prisma.affiliateConversion.aggregate({
                where: {
                    affiliateId,
                    status: {
                        in: ["CANCELLED", "REVERSED"],
                    },
                },
                _sum: {
                    commissionAmount: true,
                    orderSubtotal: true,
                },
                _count: true,
            }),

            // Clicks in current period
            prisma.affiliateClick.count({
                where: {
                    affiliateId,
                    ...(dateFrom
                        ? { createdAt: { gte: dateFrom } }
                        : {}),
                },
            }),

            // Previous period: clicks
            prevDateFrom && prevDateTo
                ? prisma.affiliateClick.count({
                      where: {
                          affiliateId,
                          createdAt: {
                              gte: prevDateFrom,
                              lt: prevDateTo,
                          },
                      },
                  })
                : Promise.resolve(0),

            // Previous period: conversions
            prevDateFrom && prevDateTo
                ? prisma.affiliateConversion.count({
                      where: {
                          affiliateId,
                          createdAt: {
                              gte: prevDateFrom,
                              lt: prevDateTo,
                          },
                      },
                  })
                : Promise.resolve(0),

            // Previous period: sales
            prevDateFrom && prevDateTo
                ? prisma.affiliateConversion
                      .aggregate({
                          where: {
                              affiliateId,
                              createdAt: {
                                  gte: prevDateFrom,
                                  lt: prevDateTo,
                              },
                          },
                          _sum: {
                              orderSubtotal: true,
                          },
                      })
                      .then(
                          (r) =>
                              Number(
                                  r._sum
                                      .orderSubtotal ?? 0
                              )
                      )
                : Promise.resolve(0),

            // Previous period: commission
            prevDateFrom && prevDateTo
                ? prisma.affiliateConversion
                      .aggregate({
                          where: {
                              affiliateId,
                              createdAt: {
                                  gte: prevDateFrom,
                                  lt: prevDateTo,
                              },
                          },
                          _sum: {
                              commissionAmount: true,
                          },
                      })
                      .then(
                          (r) =>
                              Number(
                                  r._sum
                                      .commissionAmount ?? 0
                              )
                      )
                : Promise.resolve(0),

            // Chart: clicks grouped by day (raw SQL, MariaDB backtick quoting)
            prisma.$queryRaw<
                Array<{
                    date: Date;
                    count: bigint;
                }>
            >(
                Prisma.sql`
                    SELECT DATE(cl.\`createdAt\`) AS date, COUNT(*) AS count
                    FROM \`affiliateclick\` cl
                    WHERE cl.\`affiliateId\` = ${affiliateId}
                    ${clickDateFilterSql}
                    GROUP BY DATE(cl.\`createdAt\`)
                    ORDER BY date ASC
                `
            ),

            // Chart: conversions grouped by day (raw SQL, MariaDB backtick quoting)
            prisma.$queryRaw<
                Array<{
                    date: Date;
                    count: bigint;
                    sales: bigint;
                    commission: bigint;
                }>
            >(
                Prisma.sql`
                    SELECT DATE(c.\`createdAt\`) AS date,
                           COUNT(*) AS count,
                           COALESCE(SUM(c.\`orderSubtotal\`), 0) AS sales,
                           COALESCE(SUM(c.\`commissionAmount\`), 0) AS commission
                    FROM \`affiliateconversion\` c
                    WHERE c.\`affiliateId\` = ${affiliateId}
                    ${dateFilterSql}
                    GROUP BY DATE(c.\`createdAt\`)
                    ORDER BY date ASC
                `
            ),

            // Monthly sales for earnings estimation (last 30 days)
            prisma.affiliateConversion.aggregate({
                where: {
                    affiliateId,
                    createdAt: {
                        gte: new Date(
                            now.getTime() -
                                30 *
                                    24 *
                                    60 *
                                    60 *
                                    1000
                        ),
                    },
                },
                _sum: {
                    orderSubtotal: true,
                },
            }),

            // Balance: paid commission (settled, display only)
            prisma.affiliateConversion.aggregate({
                where: {
                    affiliateId,
                    status: "PAID",
                },
                _sum: { commissionAmount: true },
            }),

            // Recent payouts
            prisma.affiliatePayout.findMany({
                where: { affiliateId },
                orderBy: { requestedAt: "desc" },
                take: 20,
            }),
        ]);

        /* ==========================================
         * BUILD CHART DATA (properly by day)
         * ========================================== */

        const chartData = buildChartData(
            chartClicks,
            chartConversions,
            days || 30
        );

        /* ==========================================
         * CONVERSION HISTORY (paginated)
         * ========================================== */

        const whereClause: any = {
            affiliateId,
        };

        if (
            statusFilter &&
            [
                "PENDING",
                "APPROVED",
                "PAID",
                "CANCELLED",
                "REVERSED",
            ].includes(statusFilter)
        ) {
            whereClause.status = statusFilter;
        }

        if (search) {
            whereClause.order = {
                orderNumber: {
                    contains: search,
                },
            };
        }

        const [conversions, totalConvCount] =
            await Promise.all([
                prisma.affiliateConversion.findMany({
                    where: whereClause,
                    orderBy: {
                        createdAt: "desc",
                    },
                    skip: (page - 1) * limit,
                    take: limit,
                    include: {
                        order: {
                            select: {
                                orderNumber: true,
                                recipientName: true,
                                total: true,
                                status: true,
                                paymentStatus: true,
                                createdAt: true,
                            },
                        },
                    },
                }),
                prisma.affiliateConversion.count({
                    where: whereClause,
                }),
            ]);

        const conversionHistory =
            conversions.map((c) => ({
                id: c.id,
                orderNumber: c.order.orderNumber,
                customerName:
                    c.order.recipientName,
                orderTotal: Number(c.orderSubtotal),
                commissionRate: Number(
                    c.commissionRate
                ),
                commissionAmount: Number(
                    c.commissionAmount
                ),
                status: c.status,
                orderStatus: c.order.status,
                paymentStatus:
                    c.order.paymentStatus,
                createdAt:
                    c.createdAt.toISOString(),
            }));

        /* ==========================================
         * RECENT ACTIVITY FEED
         * ========================================== */

        const recentActivity =
            await buildActivityFeed(affiliateId);

        /*
         * P0 FIX (C2): use the shared payout-ledger based balance
         * (approved commissions minus outstanding/paid payouts) so
         * the dashboard matches what withdrawals actually consume.
         */
        const availableBalance = await getAvailableBalance(
            affiliateId
        );

        /* ==========================================
         * COMPUTE STATS
         * ========================================== */

        const totalSales =
            Number(
                pendingConversion._sum
                    .orderSubtotal ?? 0
            ) +
            Number(
                approvedConversion._sum
                    .orderSubtotal ?? 0
            ) +
            Number(
                paidConversion._sum
                    .orderSubtotal ?? 0
            );

        const totalCommission =
            Number(
                pendingConversion._sum
                    .commissionAmount ?? 0
            ) +
            Number(
                approvedConversion._sum
                    .commissionAmount ?? 0
            ) +
            Number(
                paidConversion._sum
                    .commissionAmount ?? 0
            );

        const conversionRate =
            totalClicks > 0
                ? Number(
                      (
                          (totalConversions /
                              totalClicks) *
                          100
                      ).toFixed(2)
                  )
                : 0;

        const averageOrderValue =
            totalConversions > 0
                ? Math.round(
                      totalSales / totalConversions
                  )
                : 0;

        /* ==========================================
         * TREND COMPARISONS
         * ========================================== */

        const monthlySales = Number(
            monthlyConversions._sum.orderSubtotal ?? 0
        );
        const estimatedMonthlyCommission =
            monthlySales *
            (Number(affiliate.commissionRate) / 100);

        const trend = prevTotalClicks > 0
            ? {
                  clicks: calcTrend(
                      periodClicks,
                      prevTotalClicks
                  ),
                  conversions: calcTrend(
                      totalConversions,
                      prevTotalConversions
                  ),
                  sales: calcTrend(
                      totalSales,
                      prevTotalSales
                  ),
                  commission: calcTrend(
                      totalCommission,
                      prevTotalCommission
                  ),
              }
            : null;

        /* ==========================================
         * RESPONSE
         * ========================================== */

        return NextResponse.json({
            success: true,
            data: {
                affiliate: {
                    code: affiliate.affiliateCode,
                    commissionRate: Number(
                        affiliate.commissionRate
                    ),
                    status: affiliate.status,
                    approvedAt:
                        affiliate.approvedAt?.toISOString() ??
                        null,
                },
                stats: {
                    totalClicks,
                    totalOrders,
                    totalConversions,
                    totalSales,
                    totalCommission,
                    conversionRate,
                    averageOrderValue,
                },
                trend,
                funnel: {
                    clicks: periodClicks,
                    orders: totalOrders,
                    conversions: totalConversions,
                    commission: totalCommission,
                    conversionRate,
                },
                commission: {
                    pending: {
                        count: pendingConversion._count,
                        amount: Number(
                            pendingConversion._sum
                                .commissionAmount ?? 0
                        ),
                        sales: Number(
                            pendingConversion._sum
                                .orderSubtotal ?? 0
                        ),
                    },
                    approved: {
                        count: approvedConversion._count,
                        amount: Number(
                            approvedConversion._sum
                                .commissionAmount ?? 0
                        ),
                        sales: Number(
                            approvedConversion._sum
                                .orderSubtotal ?? 0
                        ),
                    },
                    paid: {
                        count: paidConversion._count,
                        amount: Number(
                            paidConversion._sum
                                .commissionAmount ?? 0
                        ),
                        sales: Number(
                            paidConversion._sum
                                .orderSubtotal ?? 0
                        ),
                    },
                    cancelled: {
                        count:
                            cancelledConversion._count,
                        amount: Number(
                            cancelledConversion._sum
                                .commissionAmount ?? 0
                        ),
                        sales: Number(
                            cancelledConversion._sum
                                .orderSubtotal ?? 0
                        ),
                    },
                    total: totalCommission,
                },
                balance: {
                    available: availableBalance.toNumber(),
                    pending:
                        Number(
                            pendingConversion._sum
                                .commissionAmount ?? 0
                        ),
                    paid:
                        Number(
                            paidBalance._sum
                                .commissionAmount ?? 0
                        ),
                    totalEarned: totalCommission,
                },
                payouts: recentPayouts.map((p) => ({
                    id: p.id,
                    amount: Number(p.amount),
                    status: p.status,
                    requestedAt:
                        p.requestedAt.toISOString(),
                    processedAt:
                        p.processedAt?.toISOString() ??
                        null,
                    rejectionReason:
                        p.rejectionReason ?? null,
                })),
                earnings: {
                    monthlySales,
                    commissionRate: Number(
                        affiliate.commissionRate
                    ),
                    estimatedCommission:
                        estimatedMonthlyCommission,
                },
                chart: chartData,
                conversions: {
                    items: conversionHistory,
                    pagination: {
                        page,
                        limit,
                        total: totalConvCount,
                        totalPages: Math.ceil(
                            totalConvCount / limit
                        ),
                    },
                },
                recentActivity,
            },
        });
    } catch (error) {
        console.error(
            "AFFILIATE DASHBOARD ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal mengambil data dashboard.",
            },
            { status: 500 }
        );
    }
}

/*
 * The per-day chart is built by the shared, date-safe
 * `buildChartData` in lib/affiliate/chart.ts — one implementation for
 * both reports, so a `DATE()` shape change can never fix one dashboard
 * and silently zero the other.
 */

/* ==========================================
 * TREND CALCULATOR
 * ==========================================
 *
 * Returns { value, direction, percentage }
 * comparing current vs previous period.
 */

function calcTrend(
    current: number,
    previous: number
): {
    value: number;
    direction: "up" | "down" | "flat";
    percentage: number;
} {
    if (previous === 0) {
        return {
            value: current,
            direction: current > 0 ? "up" : "flat",
            percentage: current > 0 ? 100 : 0,
        };
    }

    const change = current - previous;
    const pct = Number(
        ((change / previous) * 100).toFixed(1)
    );

    return {
        value: current,
        direction:
            change > 0
                ? "up"
                : change < 0
                ? "down"
                : "flat",
        percentage: Math.abs(pct),
    };
}

/* ==========================================
 * ACTIVITY FEED BUILDER
 * ==========================================
 *
 * Builds recent activity from clicks and
 * conversion status changes.
 */

async function buildActivityFeed(
    affiliateId: number
) {
    const [recentClicks, recentConversions] =
        await Promise.all([
            prisma.affiliateClick.findMany({
                where: { affiliateId },
                orderBy: { createdAt: "desc" },
                take: 5,
                select: {
                    id: true,
                    createdAt: true,
                },
            }),
            prisma.affiliateConversion.findMany({
                where: { affiliateId },
                orderBy: { createdAt: "desc" },
                take: 10,
                include: {
                    order: {
                        select: {
                            orderNumber: true,
                        },
                    },
                },
            }),
        ]);

    type Activity = {
        id: string;
        type: "click" | "conversion" | "commission";
        message: string;
        amount?: number;
        createdAt: string;
    };

    const activities: Activity[] = [];

    for (const click of recentClicks) {
        activities.push({
            id: `click-${click.id}`,
            type: "click",
            message: "Referral link diklik",
            createdAt: click.createdAt.toISOString(),
        });
    }

    for (const conv of recentConversions) {
        const label =
            conv.status === "APPROVED"
                ? "disetujui"
                : conv.status === "PAID"
                ? "dibayarkan"
                : conv.status === "CANCELLED"
                ? "dibatalkan"
                : "tercatat";

        activities.push({
            id: `conv-${conv.id}`,
            type:
                conv.status === "PENDING"
                    ? "conversion"
                    : "commission",
            message: `Komisi order ${conv.order.orderNumber} ${label}`,
            amount: Number(conv.commissionAmount),
            createdAt: conv.createdAt.toISOString(),
        });
    }

    activities.sort(
        (a, b) =>
            new Date(b.createdAt).getTime() -
            new Date(a.createdAt).getTime()
    );

    return activities.slice(0, 10);
}
