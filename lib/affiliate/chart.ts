/**
 * ==========================================
 * AFFILIATE CHART — DAY BUCKETS
 * ==========================================
 *
 * Both affiliate reports (the admin detail view and the affiliate's own
 * dashboard) render a per-day chart whose rows come from a raw SQL
 * `GROUP BY DATE(col)` query. This module is the single place that
 * builds those buckets, so the two reports can never drift apart.
 *
 * THE BUG THIS MODULE EXISTS TO PREVENT
 * ------------------------------------
 * A raw `DATE(col)` does NOT arrive as a string in every driver. On
 * this stack (Prisma + MariaDB) the column is a `Date` pinned to UTC
 * midnight, so a naive `String(row.date).split("T")[0]` produced
 * `"Mon Sep 28 2026 07:00:00 GMT+0700 (Western Indonesia Time)"` — a key
 * that matched no bucket, which silently zeroed the ENTIRE chart while
 * the headline totals looked correct.
 *
 * TIMEZONE CONTRACT (do not change casually)
 * -----------------------------------------
 * The bucket grid is built from UTC calendar days (`toISOString()`),
 * and datetimes are stored in UTC, so `DATE(createdAt)` is already a
 * UTC day. Row values are therefore read BACK as their UTC day; a
 * driver that returns a string (`"2026-09-28"` or ISO) normalizes to
 * the same key. Reformatting in local time would shift rows across the
 * day boundary and move counts outside the reporting window.
 */

export type ChartDay = {
    date: string;
    clicks: number;
    conversions: number;
    sales: number;
    commission: number;
};

export type ChartClickRow = {
    date: Date | string | unknown;
    count: bigint | number | string | unknown;
};

export type ChartConversionRow = {
    date: Date | string | unknown;
    count: bigint | number | string | unknown;
    sales?: bigint | number | string | unknown;
    commission?: bigint | number | string | unknown;
};

/**
 * Normalize ONE day value from a raw-SQL `DATE(...)` column into the
 * `YYYY-MM-DD` key used by the chart map.
 *
 * Returns null for a value that cannot be interpreted as a day, so the
 * caller skips it instead of inventing a bucket.
 */
export function chartDayKey(value: unknown): string | null {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime())
            ? null
            : value.toISOString().slice(0, 10);
    }

    if (typeof value === "string") {
        const trimmed = value.trim();

        // Already a DATE string (MySQL/MariaDB default) or ISO.
        const direct = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);

        if (direct) {
            return direct[1];
        }

        const parsed = new Date(trimmed);

        return Number.isNaN(parsed.getTime())
            ? null
            : parsed.toISOString().slice(0, 10);
    }

    return null;
}

/**
 * Build `days` consecutive day buckets (ending today, UTC) from raw SQL
 * rows grouped by day, filling days with no activity with zeros.
 *
 * @param clicksRows      rows of { date, count }
 * @param conversionRows  rows of { date, count, sales, commission }
 * @param days            size of the reporting window (90 in the admin
 *                        detail view, caller-supplied in the dashboard)
 */
export function buildChartData(
    clicksRows: ReadonlyArray<ChartClickRow> | undefined,
    conversionRows:
        | ReadonlyArray<ChartConversionRow>
        | undefined,
    days: number
): ChartDay[] {
    const map = new Map<string, ChartDay>();

    // The window: `days` buckets ending with TODAY's UTC day.
    const now = new Date();

    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setUTCDate(d.getUTCDate() - i);

        map.set(d.toISOString().slice(0, 10), {
            date: d.toISOString().slice(0, 10),
            clicks: 0,
            conversions: 0,
            sales: 0,
            commission: 0,
        });
    }

    /*
     * ACCUMULATE rather than assign: the SQL groups by day, so one row
     * per bucket is expected, but an accumulating write means a
     * duplicate bucket key can never silently drop counts.
     */
    for (const row of clicksRows ?? []) {
        const key = chartDayKey(row.date);
        const bucket = key ? map.get(key) : undefined;

        if (bucket) {
            bucket.clicks += Number(row.count);
        }
    }

    for (const row of conversionRows ?? []) {
        const key = chartDayKey(row.date);
        const bucket = key ? map.get(key) : undefined;

        if (bucket) {
            bucket.conversions += Number(row.count);
            bucket.sales += Number(row.sales ?? 0);
            bucket.commission += Number(
                row.commission ?? 0
            );
        }
    }

    return Array.from(map.values());
}
