import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

type Period = "today" | "yesterday" | "7d" | "30d" | "90d";
type DailyEventRow = {
    day: string;
    pageViews: bigint | number;
    visitors: bigint | number;
    checkoutStarts: bigint | number;
};
type PeriodEventSummary = {
    currentVisitors: bigint | number;
    previousVisitors: bigint | number;
    currentPageViews: bigint | number;
    previousPageViews: bigint | number;
    currentCheckoutStarts: bigint | number;
    previousCheckoutStarts: bigint | number;
};

const PERIOD_DAYS: Record<Exclude<Period, "today" | "yesterday">, number> = { "7d": 7, "30d": 30, "90d": 90 };

function wibDateKey(date: Date): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
}

function shiftDateKey(key: string, days: number): string {
    const [year, month, day] = key.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function wibMidnightUtc(key: string): Date {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day) - 7 * 60 * 60 * 1000);
}

function toNumber(value: bigint | number | undefined): number {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
}

function validPeriod(value: string | null): Period {
    return value === "today" || value === "yesterday" || value === "30d" || value === "90d" ? value : "7d";
}

export async function GET(request: Request) {
    try {
        const session = await auth();
        if (!session?.user?.id || session.user.role !== "ADMIN") {
            return NextResponse.json({ success: false, message: "Akses ditolak." }, { status: 403 });
        }

        const period = validPeriod(new URL(request.url).searchParams.get("period"));
        const now = new Date();
        const todayKey = wibDateKey(now);
        const isSingleDay = period === "today" || period === "yesterday";
        const days = isSingleDay ? 1 : PERIOD_DAYS[period];
        const currentStartKey = period === "yesterday"
            ? shiftDateKey(todayKey, -1)
            : isSingleDay
              ? todayKey
              : shiftDateKey(todayKey, -(days - 1));
        const currentEndKey = period === "yesterday"
            ? todayKey
            : isSingleDay
              ? shiftDateKey(todayKey, 1)
              : shiftDateKey(todayKey, 1);
        const previousStartKey = isSingleDay
            ? shiftDateKey(currentStartKey, -1)
            : shiftDateKey(currentStartKey, -days);
        const previousEndKey = isSingleDay
            ? currentStartKey
            : currentStartKey;
        const currentStart = wibMidnightUtc(currentStartKey);
        const previousStart = wibMidnightUtc(previousStartKey);
        const currentEnd = wibMidnightUtc(currentEndKey);
        const previousEnd = wibMidnightUtc(previousEndKey);

        const [eventRows, periodEventSummary, orders, topPages, topReferrers] = await Promise.all([
            prisma.$queryRaw<DailyEventRow[]>`
                SELECT
                    DATE_FORMAT(DATE_ADD(\`createdAt\`, INTERVAL 7 HOUR), ${isSingleDay ? "%Y-%m-%dT%H" : "%Y-%m-%d"}) AS day,
                    SUM(CASE WHEN \`eventType\` = 'PAGE_VIEW' THEN 1 ELSE 0 END) AS pageViews,
                    COUNT(DISTINCT CASE WHEN \`eventType\` = 'PAGE_VIEW' THEN \`visitorId\` END) AS visitors,
                    SUM(CASE WHEN \`eventType\` = 'CHECKOUT_START' THEN 1 ELSE 0 END) AS checkoutStarts
                FROM \`siteanalyticsevent\`
                WHERE \`createdAt\` >= ${previousStart} AND \`createdAt\` < ${currentEnd}
                GROUP BY day
                ORDER BY day ASC
            `,
            prisma.$queryRaw<PeriodEventSummary[]>`
                SELECT
                    COUNT(DISTINCT CASE WHEN \`createdAt\` >= ${currentStart} AND \`createdAt\` < ${currentEnd} AND \`eventType\` = 'PAGE_VIEW' THEN \`visitorId\` END) AS currentVisitors,
                    COUNT(DISTINCT CASE WHEN \`createdAt\` >= ${previousStart} AND \`createdAt\` < ${previousEnd} AND \`eventType\` = 'PAGE_VIEW' THEN \`visitorId\` END) AS previousVisitors,
                    SUM(CASE WHEN \`createdAt\` >= ${currentStart} AND \`createdAt\` < ${currentEnd} AND \`eventType\` = 'PAGE_VIEW' THEN 1 ELSE 0 END) AS currentPageViews,
                    SUM(CASE WHEN \`createdAt\` >= ${previousStart} AND \`createdAt\` < ${previousEnd} AND \`eventType\` = 'PAGE_VIEW' THEN 1 ELSE 0 END) AS previousPageViews,
                    SUM(CASE WHEN \`createdAt\` >= ${currentStart} AND \`createdAt\` < ${currentEnd} AND \`eventType\` = 'CHECKOUT_START' THEN 1 ELSE 0 END) AS currentCheckoutStarts,
                    SUM(CASE WHEN \`createdAt\` >= ${previousStart} AND \`createdAt\` < ${previousEnd} AND \`eventType\` = 'CHECKOUT_START' THEN 1 ELSE 0 END) AS previousCheckoutStarts
                FROM \`siteanalyticsevent\`
                WHERE \`createdAt\` >= ${previousStart} AND \`createdAt\` < ${currentEnd}
            `,
            prisma.order.findMany({
                where: { createdAt: { gte: previousStart, lt: currentEnd } },
                select: { createdAt: true, paymentStatus: true },
            }),
            prisma.siteAnalyticsEvent.groupBy({
                by: ["path"],
                where: { eventType: "PAGE_VIEW", createdAt: { gte: currentStart, lt: currentEnd } },
                _count: { _all: true },
                orderBy: { _count: { path: "desc" } },
                take: 8,
            }),
            prisma.siteAnalyticsEvent.groupBy({
                by: ["referrerHost"],
                where: {
                    eventType: "PAGE_VIEW",
                    createdAt: { gte: currentStart, lt: currentEnd },
                },
                _count: { _all: true },
                orderBy: { _count: { referrerHost: "desc" } },
                take: 8,
            }),
        ]);

        const eventByDay = new Map(eventRows.map((row) => [row.day, row]));
        const orderByDay = new Map<string, { orders: number; paidOrders: number }>();
        for (const order of orders) {
            const key = wibDateKey(order.createdAt);
            const entry = orderByDay.get(key) ?? { orders: 0, paidOrders: 0 };
            entry.orders++;
            if (order.paymentStatus === "PAID") entry.paidOrders++;
            orderByDay.set(key, entry);
        }

        const chart = Array.from({ length: isSingleDay ? 24 : days }, (_, index) => {
            if (isSingleDay) {
                const date = currentStartKey;
                const hourStart = new Date(currentStart.getTime() + index * 60 * 60 * 1000);
                const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
                const hourKey = `${date}T${String(index).padStart(2, "0")}`;
                const hourEvent = eventByDay.get(hourKey);
                const hourOrders = orders.filter((order) => order.createdAt >= hourStart && order.createdAt < hourEnd);
                return {
                    date: `${date}T${String(index).padStart(2, "0")}:00`,
                    visitors: toNumber(hourEvent?.visitors),
                    pageViews: toNumber(hourEvent?.pageViews),
                    checkoutStarts: toNumber(hourEvent?.checkoutStarts),
                    orders: hourOrders.length,
                    paidOrders: hourOrders.filter((order) => order.paymentStatus === "PAID").length,
                };
            }
            const date = shiftDateKey(currentStartKey, index);
            const event = eventByDay.get(date);
            const order = orderByDay.get(date);
            return {
                date,
                visitors: toNumber(event?.visitors),
                pageViews: toNumber(event?.pageViews),
                checkoutStarts: toNumber(event?.checkoutStarts),
                orders: order?.orders ?? 0,
                paidOrders: order?.paidOrders ?? 0,
            };
        });

        const inCurrentPeriod = (key: string) => key >= currentStartKey && key < currentEndKey;
        const currentOrders = orders.filter((order) => inCurrentPeriod(wibDateKey(order.createdAt)));
        const previousOrders = orders.filter((order) => {
            const key = wibDateKey(order.createdAt);
            return key >= previousStartKey && key < previousEndKey;
        });

        const summary = {
            visitors: toNumber(periodEventSummary[0]?.currentVisitors),
            pageViews: toNumber(periodEventSummary[0]?.currentPageViews),
            checkoutStarts: toNumber(periodEventSummary[0]?.currentCheckoutStarts),
            orders: currentOrders.length,
            paidOrders: currentOrders.filter((order) => order.paymentStatus === "PAID").length,
        };
        const previous = {
            visitors: toNumber(periodEventSummary[0]?.previousVisitors),
            pageViews: toNumber(periodEventSummary[0]?.previousPageViews),
            checkoutStarts: toNumber(periodEventSummary[0]?.previousCheckoutStarts),
            orders: previousOrders.length,
            paidOrders: previousOrders.filter((order) => order.paymentStatus === "PAID").length,
        };

        return NextResponse.json({
            success: true,
            data: {
                period,
                periodLabel: period === "today" ? "Hari ini" : period === "yesterday" ? "Kemarin" : period === "7d" ? "7 hari terakhir" : period === "30d" ? "30 hari terakhir" : "90 hari terakhir",
                summary,
                previous,
                chart,
                topPages: topPages.map((item) => ({ path: item.path, pageViews: item._count._all })),
                topReferrers: topReferrers.map((item) => ({ host: item.referrerHost || "Langsung / tidak diketahui", visits: item._count._all })),
            },
        }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        console.error("ADMIN SITE ANALYTICS ERROR:", error);
        return NextResponse.json({ success: false, message: "Data analitik belum dapat dimuat." }, { status: 500 });
    }
}
