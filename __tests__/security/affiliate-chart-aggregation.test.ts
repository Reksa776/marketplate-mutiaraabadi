/**
 * ==========================================
 * AFFILIATE CHART AGGREGATION — REGRESSION
 * ==========================================
 *
 * REGRESSION: both affiliate reports (the admin detail view and the
 * affiliate's own dashboard) render a per-day chart built from a raw
 * SQL `GROUP BY DATE(col)` query. The old builder assumed the driver
 * returns the day as a STRING:
 *
 *     const key = String(row.date).split("T")[0];
 *
 * On this stack Prisma + MariaDB returns a `Date` fixed at UTC midnight
 * (`2026-09-28T00:00:00.000Z`), so the key became
 * `"Mon Sep 28 2026 07:00:00 GMT+0700 (Western Indonesia Time)"` and
 * matched no bucket — every day rendered as ZERO while the headline
 * totals (which come from `count()`/`aggregate()`) looked correct.
 *
 * These tests pin the fixed contract:
 *   - a `Date` at UTC midnight lands in the right bucket,
 *   - string and ISO-string values land in the SAME bucket,
 *   - the window is `days` buckets ending today (UTC), with no
 *     off-by-one from local-time formatting,
 *   - rows outside the window and uninterpretable values are skipped,
 *   - both reports share ONE builder, so a fix can never apply to only
 *     one dashboard.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "affiliate-chart-test-secret";

import { readFileSync } from "fs";
import { resolve } from "path";

import {
    buildChartData,
    chartDayKey,
} from "@/lib/affiliate/chart";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC day key the builder uses, for a given instant. */
function utcDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** A raw-SQL DATE() row exactly as Prisma returns it: UTC midnight. */
function dateRow(daysAgo: number) {
    const d = new Date(
        Date.now() - daysAgo * DAY_MS
    );

    return new Date(
        Date.UTC(
            d.getUTCFullYear(),
            d.getUTCMonth(),
            d.getUTCDate()
        )
    );
}

function readFile(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf-8");
}

/* ==========================================
 * DAY KEY NORMALIZATION
 * ========================================== */

describe("chartDayKey", () => {
    test("reads a Date at UTC midnight as its UTC day", () => {
        expect(
            chartDayKey(new Date("2026-09-28T00:00:00.000Z"))
        ).toBe("2026-09-28");

        // A late-evening instant still belongs to its own UTC day —
        // local-time formatting would move it to the next day.
        expect(
            chartDayKey(new Date("2026-09-28T23:59:59.000Z"))
        ).toBe("2026-09-28");
    });

    test("reads DATE strings, ISO strings and trims whitespace", () => {
        expect(chartDayKey("2026-09-28")).toBe("2026-09-28");
        expect(
            chartDayKey("2026-09-28T00:00:00.000Z")
        ).toBe("2026-09-28");
        expect(chartDayKey("  2026-09-28  ")).toBe(
            "2026-09-28"
        );
    });

    test("returns null for values that are not a day", () => {
        expect(chartDayKey(null)).toBeNull();
        expect(chartDayKey(undefined)).toBeNull();
        expect(chartDayKey(20260928)).toBeNull();
        expect(chartDayKey({})).toBeNull();
        expect(chartDayKey("not a date")).toBeNull();
        expect(chartDayKey(new Date("nope"))).toBeNull();
    });
});

/* ==========================================
 * BUCKET FILLING
 * ========================================== */

describe("buildChartData", () => {
    test("fills the buckets a Date-valued row belongs to (the production shape)", () => {
        const today = dateRow(0);
        const threeDaysAgo = dateRow(3);

        const chart = buildChartData(
            [
                { date: today, count: BigInt(2) },
                { date: threeDaysAgo, count: 1 },
            ],
            [
                {
                    date: today,
                    count: BigInt(1),
                    sales: BigInt(40_000),
                    commission: "2000",
                },
            ],
            7
        );

        expect(chart).toHaveLength(7);

        const byDate = new Map(
            chart.map((day) => [day.date, day])
        );

        expect(byDate.get(utcDay(today))).toEqual({
            date: utcDay(today),
            clicks: 2,
            conversions: 1,
            sales: 40_000,
            commission: 2000,
        });

        expect(byDate.get(utcDay(threeDaysAgo))!.clicks).toBe(
            1
        );

        // Totals — the assertion that failed while the key was wrong.
        expect(
            chart.reduce((sum, day) => sum + day.clicks, 0)
        ).toBe(3);
        expect(
            chart.reduce(
                (sum, day) => sum + day.conversions,
                0
            )
        ).toBe(1);

        // Days with no activity are present and zeroed.
        expect(
            chart.filter((day) => day.clicks === 0)
        ).toHaveLength(5);
    });

    test("string, ISO-string and Date rows land in the SAME bucket", () => {
        const day = utcDay(dateRow(1));

        const chart = buildChartData(
            [
                { date: day, count: 1 },
                { date: `${day}T00:00:00.000Z`, count: 1 },
                { date: dateRow(1), count: 1 },
            ],
            [],
            7
        );

        const bucket = chart.find((d) => d.date === day)!;

        expect(bucket.clicks).toBe(3);
    });

    test("the 90-day window is exactly 90 UTC days ending today", () => {
        const chart = buildChartData([], [], 90);

        expect(chart).toHaveLength(90);
        expect(chart[chart.length - 1].date).toBe(
            utcDay(new Date())
        );
        expect(chart[0].date).toBe(utcDay(dateRow(89)));

        // Distinct, ascending, contiguous days.
        const days = chart.map((d) => d.date);
        expect(new Set(days).size).toBe(90);
        expect([...days].sort()).toEqual(days);
    });

    test("a row older than the window is not reported (and cannot shift a bucket)", () => {
        const chart = buildChartData(
            [
                { date: dateRow(120), count: 5 },
                { date: dateRow(0), count: 1 },
            ],
            [],
            90
        );

        expect(
            chart.reduce((sum, day) => sum + day.clicks, 0)
        ).toBe(1);
    });

    test("uninterpretable values are skipped, never invented", () => {
        const today = dateRow(0);

        const chart = buildChartData(
            [
                { date: null, count: 4 },
                { date: {}, count: 4 },
                { date: "??", count: 4 },
                { date: today, count: 1 },
            ] as never,
            [{ date: undefined, count: 1 }] as never,
            7
        );

        expect(chart).toHaveLength(7);
        expect(
            chart.reduce((sum, day) => sum + day.clicks, 0)
        ).toBe(1);
        expect(
            chart.reduce(
                (sum, day) => sum + day.conversions,
                0
            )
        ).toBe(0);
    });

    test("a duplicate bucket key accumulates instead of dropping counts", () => {
        const day = utcDay(dateRow(0));

        const chart = buildChartData(
            [
                { date: day, count: 2 },
                { date: day, count: 3 },
            ],
            [],
            7
        );

        expect(
            chart.find((d) => d.date === day)!.clicks
        ).toBe(5);
    });

    test("handles empty result sets", () => {
        const chart = buildChartData([], [], 30);

        expect(chart).toHaveLength(30);
        expect(
            chart.every(
                (day) =>
                    day.clicks === 0 &&
                    day.conversions === 0 &&
                    day.sales === 0 &&
                    day.commission === 0
            )
        ).toBe(true);
    });

    test("tolerates undefined rows (a report that was not requested)", () => {
        expect(() =>
            buildChartData(undefined, undefined, 30)
        ).not.toThrow();
        expect(
            buildChartData(undefined, undefined, 30)
        ).toHaveLength(30);
    });
});

/* ==========================================
 * ONE BUILDER FOR BOTH REPORTS
 * ========================================== */

describe("both affiliate reports use the shared builder", () => {
    const reports = [
        "app/api/admin/affiliate/[id]/route.ts",
        "app/api/affiliate/dashboard/route.ts",
    ];

    test.each(reports)(
        "%s imports buildChartData instead of defining its own",
        (path) => {
            const code = readFile(path);

            expect(code).toContain(
                'from "@/lib/affiliate/chart"'
            );

            // A local copy is how the bug survived in one report while
            // the other was fixed.
            expect(code).not.toMatch(
                /function buildChartData\(/
            );
            expect(code).not.toContain(
                'String(row.date).split("T")[0]'
            );
        }
    );

    test("the shared builder formats keys in UTC, never local time", () => {
        const chart = readFile("lib/affiliate/chart.ts");

        expect(chart).toContain("toISOString().slice(0, 10)");
        expect(chart).not.toContain("toLocaleDateString");
        expect(chart).not.toContain("getFullYear()");

        // The window steps in UTC days so it is exactly `days` buckets
        // even across a DST boundary.
        expect(chart).toContain("setUTCDate");
    });
});
