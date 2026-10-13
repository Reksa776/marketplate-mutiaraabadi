/**
 * ==========================================
 * AFFILIATE DASHBOARD — MariaDB Raw SQL Regression
 * ==========================================
 *
 * Ensures the dashboard route uses MariaDB-compatible
 * backtick-quoted identifiers and does NOT use
 * PostgreSQL-style double-quote identifiers in raw SQL.
 *
 * Run: npx tsx __tests__/admin/affiliate-dashboard-mariadb.test.ts
 */

import { readFileSync } from "fs";

function readFile(path: string): string {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return "";
    }
}

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(`FAIL: ${message}`);
    }
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e: any) {
        console.log(`  ❌ ${name}: ${e.message}`);
        failed++;
    }
}

console.log(
    "\n=== AFFILIATE DASHBOARD — MariaDB Regression Tests ===\n"
);

const dashboard = readFile(
    "app/api/affiliate/dashboard/route.ts"
);

// ==========================================
// 1. PostgreSQL identifier quoting removed
// ==========================================

console.log(
    "1. PostgreSQL double-quote identifiers removed:"
);

test(
    'No "AffiliateClick" in raw SQL (should use backticks)',
    () => {
        // Look for "AffiliateClick" inside SQL template literal context
        // (not just in comments or Prisma model references)
        assert(
            !dashboard.includes(
                'SELECT"AffiliateClick"'
            ) &&
                !dashboard.includes(
                    'FROM"AffiliateClick"'
                ) &&
                !dashboard.includes(
                    'FROM "AffiliateClick"'
                ),
            'Found PostgreSQL-style "AffiliateClick" in raw SQL'
        );
    }
);

test(
    'No "AffiliateConversion" in raw SQL (should use backticks)',
    () => {
        assert(
            !dashboard.includes(
                'FROM"AffiliateConversion"'
            ) &&
                !dashboard.includes(
                    'FROM "AffiliateConversion"'
                ),
            'Found PostgreSQL-style "AffiliateConversion" in raw SQL'
        );
    }
);

test(
    'No "createdAt" with double quotes in raw SQL',
    () => {
        // Check for PostgreSQL-style "createdAt" in SQL context
        assert(
            !dashboard.includes('"createdAt" >='),
            'Found PostgreSQL-style "createdAt" in raw SQL'
        );
    }
);

test(
    'No "affiliateId" with double quotes in raw SQL',
    () => {
        assert(
            !dashboard.includes('"affiliateId" ='),
            'Found PostgreSQL-style "affiliateId" in raw SQL'
        );
    }
);

test(
    'No "orderSubtotal" with double quotes in raw SQL',
    () => {
        assert(
            !dashboard.includes('"orderSubtotal"'),
            'Found PostgreSQL-style "orderSubtotal" in raw SQL'
        );
    }
);

test(
    'No "commissionAmount" with double quotes in raw SQL',
    () => {
        assert(
            !dashboard.includes('"commissionAmount"'),
            'Found PostgreSQL-style "commissionAmount" in raw SQL'
        );
    }
);

// ==========================================
// 2. MariaDB backtick identifiers present
// ==========================================

console.log(
    "\n2. MariaDB backtick identifiers present:"
);

test(
    "Uses Prisma.sql template literal for date filters",
    () => {
        assert(
            dashboard.includes("Prisma.sql`"),
            "Should use Prisma.sql template literal"
        );
    }
);

test(
    "Uses Prisma.empty for optional date filters",
    () => {
        assert(
            dashboard.includes("Prisma.empty"),
            "Should use Prisma.empty for optional filters"
        );
    }
);

/*
 * The table names below are the MariaDB identifiers declared in
 * prisma/schema.prisma (`@@map("affiliateclick")` ...), which is what the
 * live database actually contains. MariaDB is case-sensitive on Linux, so
 * asserting the Prisma MODEL name would assert a table that does not
 * exist - the raw SQL must quote the mapped name.
 */

const affiliateClickTable = "affiliateclick";
const affiliateConversionTable = "affiliateconversion";

test(
    "AffiliateClick table uses backtick quoting",
    () => {
        // Backtick in the source file shows as \` in the file
        assert(
            dashboard.includes("\\`" + affiliateClickTable + "\\`"),
            "AffiliateClick table should use backtick quoting"
        );
    }
);

test(
    "AffiliateConversion table uses backtick quoting",
    () => {
        assert(
            dashboard.includes("\\`" + affiliateConversionTable + "\\`"),
            "AffiliateConversion table should use backtick quoting"
        );
    }
);

test(
    "Raw SQL table names match their Prisma @@map names",
    () => {
        const schema = readFile("prisma/schema.prisma");

        for (const [model, table] of [
            ["AffiliateClick", affiliateClickTable],
            ["AffiliateConversion", affiliateConversionTable],
        ] as const) {
            const start = schema.indexOf("model " + model + " ");
            assert(
                start >= 0,
                model + " model missing from schema.prisma"
            );

            const end = schema.indexOf("\n}", start);
            const modelBlock = schema.slice(
                start,
                end > 0 ? end : undefined
            );
            const mapping = '@@map("' + table + '")';

            assert(
                modelBlock.includes(mapping),
                model + " must declare " + mapping + " to match the raw SQL"
            );
        }
    }
);

test(
    "createdAt field uses backtick quoting",
    () => {
        assert(
            dashboard.includes("\\`createdAt\\`"),
            "createdAt field should use backtick quoting"
        );
    }
);

test(
    "affiliateId field uses backtick quoting",
    () => {
        assert(
            dashboard.includes("\\`affiliateId\\`"),
            "affiliateId field should use backtick quoting"
        );
    }
);

// ==========================================
// 3. No $queryRawUnsafe (SQL injection risk)
// ==========================================

console.log(
    "\n3. SQL injection prevention:"
);

test(
    "No $queryRawUnsafe usage (should use $queryRaw)",
    () => {
        assert(
            !dashboard.includes("$queryRawUnsafe"),
            "Should not use $queryRawUnsafe (SQL injection risk)"
        );
    }
);

test(
    "Uses prisma.$queryRaw for chart queries",
    () => {
        assert(
            dashboard.includes("prisma.$queryRaw<"),
            "Should use typed prisma.$queryRaw"
        );
    }
);

test(
    "affiliateId is parameterized (not string-interpolated)",
    () => {
        // In Prisma.sql template, ${affiliateId} is parameterized
        // Verify no hardcoded numeric affiliateId in SQL
        assert(
            !dashboard.includes(
                "WHERE cl.affiliateId = 1"
            ) &&
                !dashboard.includes(
                    "WHERE c.affiliateId = 1"
                ),
            "affiliateId should not be hardcoded in SQL"
        );
    }
);

test(
    "No string concatenation of user input into SQL",
    () => {
        // Should not have patterns like: `...${search}...` inside SQL
        assert(
            !dashboard.includes(
                "WHERE search LIKE"
            ) &&
                !dashboard.includes(
                    "WHERE cl.search"
                ),
            "Search input should not be concatenated into raw SQL"
        );
    }
);

// ==========================================
// 4. DATE() aggregation for daily chart
// ==========================================

console.log(
    "\n4. Daily chart aggregation:"
);

test(
    "Chart clicks uses DATE() aggregation",
    () => {
        assert(
            dashboard.includes(
                "DATE(cl.`createdAt`)"
            ) ||
                dashboard.includes(
                    "DATE(cl.\\`createdAt\\`)"
                ),
            "Click chart should use DATE() for daily aggregation"
        );
    }
);

test(
    "Chart conversions uses DATE() aggregation",
    () => {
        assert(
            dashboard.includes(
                "DATE(c.`createdAt`)"
            ) ||
                dashboard.includes(
                    "DATE(c.\\`createdAt\\`)"
                ),
            "Conversion chart should use DATE() for daily aggregation"
        );
    }
);

test(
    "Chart uses GROUP BY DATE() (not GROUP BY createdAt)",
    () => {
        assert(
            dashboard.includes("GROUP BY DATE("),
            "Chart should GROUP BY DATE() not raw timestamp"
        );
        // Make sure there's no bare GROUP BY createdAt
        assert(
            !dashboard.includes(
                "GROUP BY cl.`createdAt`"
            ) &&
                !dashboard.includes(
                    "GROUP BY c.`createdAt`"
                ),
            "Should not GROUP BY raw timestamp (causes per-second groups)"
        );
    }
);

// ==========================================
// 5. Prisma import
// ==========================================

console.log(
    "\n5. Prisma import:"
);

test(
    "Imports Prisma namespace for sql and empty",
    () => {
        assert(
            dashboard.includes(
                'import { Prisma } from "@prisma/client"'
            ),
            "Should import Prisma namespace for Prisma.sql and Prisma.empty"
        );
    }
);

// ==========================================
// 6. Dashboard features preserved
// ==========================================

console.log(
    "\n6. Dashboard features preserved:"
);

test("Returns clicks data", () => {
    assert(
        dashboard.includes("totalClicks"),
        "Should return totalClicks"
    );
});

test("Returns conversions data", () => {
    assert(
        dashboard.includes("totalConversions"),
        "Should return totalConversions"
    );
});

test("Returns sales data", () => {
    assert(
        dashboard.includes("totalSales"),
        "Should return totalSales"
    );
});

test("Returns commission data", () => {
    assert(
        dashboard.includes("totalCommission"),
        "Should return totalCommission"
    );
});

test("Returns chart data", () => {
    assert(
        dashboard.includes("chartData") ||
            dashboard.includes("chart:"),
        "Should return chart data"
    );
});

test("Returns funnel data", () => {
    assert(
        dashboard.includes("funnel:"),
        "Should return funnel data"
    );
});

test("Returns KPI trend", () => {
    assert(
        dashboard.includes("trend"),
        "Should return trend/KPI data"
    );
});

test("Returns payout history", () => {
    assert(
        dashboard.includes("payouts:"),
        "Should return payout history"
    );
});

test("Returns recent activity", () => {
    assert(
        dashboard.includes("recentActivity"),
        "Should return recent activity"
    );
});

test("Returns conversion history", () => {
    assert(
        dashboard.includes("conversions:"),
        "Should return conversion history"
    );
});

test("Supports pagination", () => {
    assert(
        dashboard.includes("page") &&
            dashboard.includes("limit"),
        "Should support pagination"
    );
});

test("Supports search filter", () => {
    assert(
        dashboard.includes("search"),
        "Should support search"
    );
});

test("Supports status filter", () => {
    assert(
        dashboard.includes("statusFilter"),
        "Should support status filter"
    );
});

test("Supports days filter", () => {
    assert(
        dashboard.includes("daysParam") ||
            dashboard.includes('"days"'),
        "Should support days filter"
    );
});

test("Returns balance data", () => {
    assert(
        dashboard.includes("balance:"),
        "Should return balance data"
    );
});

// ==========================================
// RESULTS
// ==========================================

console.log(
    "\n" + "=".repeat(50)
);
console.log(
    `\n📊 RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total\n`
);

if (failed > 0) {
    console.log("❌ Some tests failed!\n");
    process.exit(1);
} else {
    console.log("✅ All tests passed!\n");
}
