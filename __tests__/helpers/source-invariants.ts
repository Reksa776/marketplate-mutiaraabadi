/**
 * ==========================================
 * SHARED SOURCE-INTROSPECTION HELPERS
 * ==========================================
 *
 * Used by the legacy audit scripts (`__tests__/checkout/lifecycle.test.ts`
 * and `__tests__/transaction/t5-e2e-verification.test.ts`), which assert
 * security invariants by reading source files rather than executing them.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Those assertions kept failing for the wrong reason: they matched the
 * exact TEXT of a statement instead of the invariant behind it. Three
 * formatting changes made them lie about the code:
 *
 *   1. MariaDB identifier quoting — the same statement is written
 *      `UPDATE flashsale`, ``UPDATE `flashsale` `` (backticked) or
 *      ``UPDATE \`flashsale\` `` (escaped, inside a Prisma.sql template)
 *      depending on the file.
 *   2. Route imports became MULTI-LINE when the guest limiters were added,
 *      so `import { rateLimiters } from "@/lib/rate-limit"` no longer
 *      matches as a single-line substring.
 *   3. Shared primitives moved (rollback CAS → cancelOrderForReservations,
 *      stock/voucher release → order-stock.ts), so positional slices
 *      anchored on neighbouring identifiers silently captured the wrong
 *      (or an empty) region.
 *
 * `sqlText()`/`hasSql()` make SQL assertions quoting- and case-agnostic,
 * and `functionBody()` scopes an assertion to ONE function by brace
 * matching instead of by a fragile substring slice.
 */

import * as fs from "fs";
import * as path from "path";

/** Read a repo-relative source file. */
export function readSource(relativePath: string): string {
    return fs.readFileSync(
        path.resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

/**
 * Normalize source for SQL-identifier assertions.
 *
 * Removes MariaDB backtick quoting (including the `\`` escape used inside
 * Prisma.sql templates), collapses whitespace and lower-cases, so an
 * assertion matches the SQL the DATABASE receives rather than one file's
 * formatting.
 */
export function sqlText(src: string): string {
    return src
        .replace(/\\`/g, "`")
        .replace(/`/g, "")
        .replace(/\s+/g, " ")
        .toLowerCase();
}

/** Assert on SQL text regardless of backtick quoting / casing / line breaks. */
export function hasSql(src: string, snippet: string): boolean {
    return sqlText(src).includes(sqlText(snippet));
}

/**
 * Normalize non-SQL source (imports, object literals) for assertions:
 * whitespace (including newlines) collapsed so a multi-line construct
 * matches a single-line expectation.
 */
export function flat(src: string): string {
    return src.replace(/\s+/g, " ");
}

/** Whitespace-insensitive containment for non-SQL source. */
export function hasFlat(src: string, snippet: string): boolean {
    return flat(src).includes(flat(snippet));
}

/**
 * Body of the first function whose signature contains `signature`
 * (e.g. "export async function rollbackCheckoutOrder").
 *
 * Returns "" when the signature is absent so the caller's assertion fails
 * with its own message instead of silently matching the wrong region.
 *
 * NOTE: braces inside string literals would confuse the depth counter;
 * none of the functions asserted on here have them, and a miscount fails
 * loudly (the caller sees a wrong/empty body) instead of passing.
 */
export function functionBody(
    src: string,
    signature: string
): string {
    const start = src.indexOf(signature);

    if (start < 0) return "";

    /*
     * Skip the PARAMETER LIST first: its type literal is itself a brace
     * group (`options?: { restoreCart?: boolean }`), so taking the first
     * `{` after the signature would stop at the end of the parameters
     * instead of the end of the function.
     */
    const parenOpen = src.indexOf("(", start);

    if (parenOpen < 0) return "";

    let parenDepth = 0;
    let parenClose = -1;

    for (let i = parenOpen; i < src.length; i++) {
        const ch = src[i];

        if (ch === "(") {
            parenDepth++;
        } else if (ch === ")") {
            parenDepth--;

            if (parenDepth === 0) {
                parenClose = i;
                break;
            }
        }
    }

    if (parenClose < 0) return "";

    const open = src.indexOf("{", parenClose);

    if (open < 0) return "";

    let depth = 0;

    for (let i = open; i < src.length; i++) {
        const ch = src[i];

        if (ch === "{") {
            depth++;
        } else if (ch === "}") {
            depth--;

            if (depth === 0) {
                return src.slice(open, i + 1);
            }
        }
    }

    return src.slice(open);
}

/**
 * Index of `needle` inside `haystack`, or -1 — used to assert ORDERING
 * (e.g. "the CAS update happens before the stock release").
 */
export function indexOfNormalized(
    haystack: string,
    needle: string
): number {
    return flat(haystack).indexOf(flat(needle));
}
