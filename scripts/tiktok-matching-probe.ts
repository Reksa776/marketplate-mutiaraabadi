/**
 * ==========================================
 * TEMPORARY — TIKTOK IDENTITY MATCHING DIAGNOSTIC (READ-ONLY)
 * ==========================================
 *
 * Purpose: send EXACTLY ONE synthetic CompletePayment to TikTok Test
 * Events carrying hashed email + phone + external_id, to verify the
 * production matching pipeline end-to-end.
 *
 * SAFETY
 *   - reads ONE existing user (email + phone) READ-ONLY
 *   - NEVER prints raw email / phone / user id, nor the Access Token
 *   - writes NOTHING to the database: no order, no user, no payment,
 *     no paymentStatus / orderStatus change
 *   - uses the PRODUCTION helpers (buildTikTokUserMatch +
 *     sendTikTokEvent) so the payload is byte-identical to the app's
 *   - refuses to send unless TIKTOK_TEST_EVENT_CODE is configured
 *     (otherwise the event would count as REAL production traffic)
 *   - sends at most ONE event per invocation
 *
 * RUN
 *   # the server-only helpers need a stub under plain Node/tsx:
 *   mkdir -p node_modules/server-only && \
 *     printf '{"name":"server-only","version":"0.0.0","main":"index.js"}' > node_modules/server-only/package.json && \
 *     printf 'module.exports = {};\n' > node_modules/server-only/index.js
 *
 *   npx tsx scripts/tiktok-matching-probe.ts            # preflight (no send)
 *   npx tsx scripts/tiktok-matching-probe.ts --send     # send exactly ONE
 *
 *   # cleanup afterwards:
 *   rm -rf node_modules/server-only scripts/tiktok-matching-probe.ts
 */

import { loadEnvConfig } from "@next/env";

import { PrismaClient } from "@prisma/client";

import {
    buildTikTokUserMatch,
} from "../lib/analytics/tiktok-user-match";

import {
    getTikTokEventsApiConfig,
} from "../lib/analytics/tiktok-events-config";

import {
    sendTikTokEvent,
} from "../lib/analytics/tiktok-events-api";

import { TIKTOK_CURRENCY } from "../lib/analytics/tiktok-catalog";

const shouldSend = process.argv.includes("--send");

function loadProjectEnv(): string[] {
    const log = { info: () => {}, error: () => {} };

    const production = loadEnvConfig(process.cwd(), false, log);

    if (process.env.DATABASE_URL) {
        return production.loadedEnvFiles.map((f) => f.path);
    }

    const development = loadEnvConfig(
        process.cwd(),
        true,
        log,
        true
    );

    return development.loadedEnvFiles.map((f) => f.path);
}

/** First 4 + last 4 of a digest. Never the full hash, never raw PII. */
function mask(digest: string | undefined): string {
    if (!digest) {
        return "MISSING";
    }
    return `${digest.slice(0, 4)}••••${digest.slice(-4)}`;
}

async function main() {
    console.log("\n━━━ ENVIRONMENT ━━━");

    const envFiles = loadProjectEnv();

    console.log(
        "  env files loaded:",
        envFiles.length > 0 ? envFiles.join(", ") : "none"
    );
    console.log(
        "  DATABASE_URL:",
        process.env.DATABASE_URL
            ? "present (not printed)"
            : "MISSING"
    );
    console.log(
        "  TIKTOK_TEST_EVENT_CODE:",
        process.env.TIKTOK_TEST_EVENT_CODE
            ? "visible to this process"
            : "not set / unusable"
    );

    const prisma = new PrismaClient({ log: [] });

    let user: {
        id: string;
        email: string | null;
        phone: string | null;
    } | null = null;

    try {
        user = await prisma.user.findFirst({
            where: {
                AND: [
                    { email: { not: null } },
                    { phone: { not: null } },
                ],
            },
            select: { id: true, email: true, phone: true },
            orderBy: { id: "asc" },
        });
    } finally {
        await prisma.$disconnect();
    }

    if (!user) {
        console.log(
            "\n  NO safe existing user with email + phone. STOP — no user will be created."
        );
        process.exitCode = 1;
        return;
    }

    const match = buildTikTokUserMatch({
        email: user.email,
        phone: user.phone,
        externalId: user.id,
    });

    console.log("\n━━━ MATCHING PAYLOAD (metadata only) ━━━");
    console.log(
        "  email:       ",
        match.email ? `SHA-256 ${mask(match.email)}` : "MISSING"
    );
    console.log(
        "  phone:       ",
        match.phone ? `SHA-256 ${mask(match.phone)}` : "MISSING"
    );
    console.log(
        "  external_id: ",
        match.external_id
            ? `SHA-256 ${mask(match.external_id)}`
            : "MISSING"
    );
    console.log("  raw PII printed: NO");

    const config = await getTikTokEventsApiConfig();

    console.log("\n━━━ EVENTS API CONFIG ━━━");
    console.log("  pixel enabled:   ", config.enabled);
    console.log(
        "  pixel id:        ",
        config.pixelId ?? "MISSING"
    );
    console.log(
        "  access token:    ",
        config.accessToken
            ? "present (not printed)"
            : "MISSING"
    );
    console.log(
        "  test_event_code: ",
        config.testEventCode ? "CONFIGURED" : "NOT CONFIGURED"
    );

    if (!shouldSend) {
        console.log(
            "\n  preflight only (no --send). NOTHING SENT.\n"
        );
        process.exitCode = 0;
        return;
    }

    if (!config.testEventCode) {
        console.log(
            "\n  REFUSING TO SEND: TIKTOK_TEST_EVENT_CODE is not configured."
        );
        console.log(
            "  Sending now would count as REAL production traffic.\n"
        );
        process.exitCode = 1;
        return;
    }

    if (!config.enabled || !config.pixelId || !config.accessToken) {
        console.log(
            "\n  REFUSING TO SEND: Events API is not usable (see config above).\n"
        );
        process.exitCode = 1;
        return;
    }

    const reference = `TIKTOK-MATCH-DIAGNOSTIC-${Date.now()}-${Math.floor(
        Math.random() * 1_000_000
    )}`;
    const eventId = `ttq:completepayment:${reference}`;

    console.log("\n━━━ SENDING EXACTLY ONE SYNTHETIC EVENT ━━━");
    console.log("  event: CompletePayment (synthetic, no real order)");
    console.log("  reference:", reference);
    console.log(
        "  user keys included:",
        Object.keys(match).sort().join(", ") || "none"
    );

    const result = await sendTikTokEvent({
        event: "CompletePayment",
        eventId,
        value: 0,
        currency: TIKTOK_CURRENCY,
        orderId: reference,
        user: match,
    });

    console.log("\n━━━ RESULT ━━━");
    console.log("  accepted:", result.ok);
    console.log("  skipped: ", result.skipped, result.reason ?? "");
    console.log("  HTTP status:", result.status ?? "—");
    console.log("  TikTok code:", result.code ?? "—");
    console.log("  TikTok message:", result.message ?? "—");
    console.log("  request_id:", result.requestId ?? "—");
    console.log(
        "  test_event_code configured:",
        result.testEventCodeConfigured
    );
    console.log("  email hash included: YES");
    console.log("  phone hash included: YES");
    console.log("  external_id hash included: YES");
    console.log("  raw PII printed: NO");
    console.log("  DB mutated: NO\n");

    process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
    console.error(
        "TIKTOK MATCHING PROBE FAILED:",
        error instanceof Error ? error.name : "unknown"
    );
    process.exitCode = 1;
});
