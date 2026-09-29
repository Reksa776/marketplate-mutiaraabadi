/**
 * ==========================================
 * TIKTOK EVENTS API — DELIVERY DIAGNOSTIC
 * ==========================================
 *
 * Run (read-only audit):
 *   npx tsx scripts/tiktok-events-api-check.ts
 *
 * Run (audit + ONE live Test Event):
 *   npx tsx scripts/tiktok-events-api-check.ts --send
 *
 * WHY THIS EXISTS
 *   "No [TIKTOK EVENTS API] line in the logs" used to be
 *   impossible to interpret: a skipped request and a delivered
 *   request both produced no output. This script answers, from
 *   the SAME machine, .env and database the app uses:
 *
 *     1. is the stored Pixel configuration usable at all?
 *     2. does this process actually see TIKTOK_TEST_EVENT_CODE?
 *     3. what does TikTok answer, byte for byte, for a
 *        CompletePayment event — HTTP status, `code`, `message`
 *        and `request_id`?
 *
 * SAFETY
 *   - never prints the Access Token, the Test Event Code value,
 *     or any customer data
 *   - read-only unless `--send` is passed
 *   - the `--send` probe carries no PII and no order data; with
 *     TIKTOK_TEST_EVENT_CODE set it is routed to the Events
 *     Manager "Test Events" view and stays out of reporting
 */

import { prisma } from "@/lib/prisma";

import {
    TIKTOK_EVENTS_API_TIMEOUT_MS,
    TIKTOK_EVENTS_API_URL,
    sendTikTokEvent,
} from "@/lib/analytics/tiktok-events-api";

import { getTikTokEventsApiConfig } from "@/lib/analytics/tiktok-events-config";

import { buildTikTokEventId } from "@/lib/analytics/tiktok";

import { TIKTOK_CURRENCY } from "@/lib/analytics/tiktok-catalog";

const shouldSend = process.argv.includes("--send");

function line(label: string, value: string) {
    console.log(`  ${label.padEnd(28)} ${value}`);
}

function boolean(value: boolean): string {
    return value ? "yes" : "NO";
}

async function main() {
    console.log(
        "\n━━━ TIKTOK EVENTS API CONFIGURATION ━━━"
    );

    const config = await getTikTokEventsApiConfig();

    line("endpoint", TIKTOK_EVENTS_API_URL);
    line(
        "timeout",
        `${TIKTOK_EVENTS_API_TIMEOUT_MS} ms`
    );
    line(
        "StoreSetting read",
        config.unavailableReason
            ? `FAILED (${config.unavailableReason})`
            : "ok"
    );
    line(
        "pixel enabled",
        boolean(config.enabled)
    );
    /*
     * The Pixel ID is public (it ships in the storefront base
     * code), so it is printed. The Access Token never is.
     */
    line(
        "pixel id (StoreSetting)",
        config.pixelId ??
            "INVALID / MISSING (format rejected)"
    );
    line(
        "access token",
        config.accessToken
            ? `present (${config.accessToken.length} chars)`
            : "MISSING"
    );
    line(
        "test_event_code",
        config.testEventCode
            ? `configured (${config.testEventCode.length} chars)`
            : "not configured"
    );

    const ready =
        !config.unavailableReason &&
        config.enabled &&
        config.pixelId !== null &&
        config.accessToken !== null;

    console.log(
        `\n  verdict: ${
            ready
                ? "the sender WOULD make a request"
                : "the sender would SKIP (see the reason above)"
        }`
    );

    if (!config.testEventCode) {
        console.log(
            "  ⚠️  Without TIKTOK_TEST_EVENT_CODE the event is counted as REAL traffic."
        );
    }

    if (!shouldSend) {
        console.log(
            "\n  (add --send to also post one CompletePayment Test Event to TikTok)\n"
        );
        return;
    }

    const reference = `TIKTOK-DIAGNOSTIC-${Date.now()}`;

    console.log(
        "\n━━━ LIVE TEST EVENT ━━━"
    );
    console.log(
        `  sending CompletePayment ${reference} (no PII, no order)`
    );

    const result = await sendTikTokEvent({
        event: "CompletePayment",
        eventId: buildTikTokEventId(
            "CompletePayment",
            reference
        ),
        value: 1,
        currency: TIKTOK_CURRENCY,
        orderId: reference,
        pageUrl:
            "https://diagnostic.invalid/tiktok-events-api-check",
    });

    console.log("\n  result:");
    line("ok", boolean(result.ok));
    line("skipped", boolean(result.skipped));
    line(
        "reason",
        result.reason ?? "—"
    );
    line(
        "http status",
        String(result.status ?? "—")
    );
    line(
        "tiktok code",
        String(result.code ?? "—")
    );
    line(
        "tiktok message",
        result.message ?? "—"
    );
    line(
        "request_id",
        result.requestId ?? "—"
    );
    line(
        "test_event_code used",
        boolean(result.testEventCodeConfigured)
    );

    if (!result.ok) {
        console.log(
            "\n  → Quote the http status, tiktok code and request_id above when escalating to TikTok.\n"
        );
    }
}

main()
    .catch((error) => {
        /*
         * Name only: a driver error message can embed the
         * database URL (credentials included).
         */
        console.error(
            "TIKTOK EVENTS API CHECK FAILED:",
            error instanceof Error
                ? error.name
                : "unknown"
        );

        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
