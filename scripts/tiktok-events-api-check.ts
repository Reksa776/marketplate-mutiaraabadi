/**
 * ==========================================
 * TIKTOK EVENTS API — DELIVERY DIAGNOSTIC (STANDALONE)
 * ==========================================
 *
 * Run from the project root:
 *   npx tsx scripts/tiktok-events-api-check.ts
 *   npx tsx scripts/tiktok-events-api-check.ts --send
 *
 * STANDALONE BY CONSTRUCTION
 *   This script must run under plain Node/tsx, i.e. WITHOUT the
 *   Next.js bundler. It therefore imports NO module marked
 *   `server-only` (`lib/analytics/tiktok-events-api.ts`,
 *   `tiktok-events-config.ts` and `tiktok-user-match.ts` all
 *   `import "server-only"`, which tsx cannot resolve — hence the
 *   old "Cannot find module 'server-only'" failure).
 *
 *   What it imports instead:
 *     - lib/analytics/tiktok-events-api-probe.ts
 *           zero-import probe contract (payload + response parsing)
 *     - lib/analytics/tiktok.ts
 *     - lib/analytics/tiktok-access-token.ts
 *     - lib/analytics/tiktok-test-event-code.ts
 *           the SAME pure normalizers the application uses, so the
 *           script can never disagree with the app about whether a
 *           stored Pixel ID / Access Token / test event code is
 *           usable
 *     - @prisma/client (a private, read-only client; no app
 *           singleton, no ORM query logging, no writes)
 *
 *   The application implementation, the webhook settlement path and
 *   the `server-only` protection are all untouched.
 *
 * IT ANSWERS, FROM THE SAME MACHINE, .env AND DATABASE AS THE APP
 *   1. is the stored Pixel configuration usable at all?
 *   2. does this process actually see TIKTOK_TEST_EVENT_CODE?
 *   3. what does TikTok answer, byte for byte, for a CompletePayment
 *      probe — HTTP status, `code`, `message` and `request_id`?
 *
 * SAFETY
 *   - read-only unless `--send` is passed
 *   - never prints the Access Token, the test event code value, any
 *     customer identifier, or a request/response body
 *   - the probe carries no PII and no order data; with
 *     TIKTOK_TEST_EVENT_CODE set it is routed to the Events Manager
 *     "Test Events" view and stays out of reporting
 */

import { loadEnvConfig } from "@next/env";

import { PrismaClient } from "@prisma/client";

import {
    normalizeTikTokPixelId,
} from "../lib/analytics/tiktok";

import {
    normalizeTikTokPixelAccessToken,
} from "../lib/analytics/tiktok-access-token";

import {
    getTikTokTestEventCode,
} from "../lib/analytics/tiktok-test-event-code";

import {
    TIKTOK_EVENTS_API_ENDPOINT,
    TIKTOK_EVENTS_API_TOKEN_HEADER,
    TIKTOK_PROBE_TIMEOUT_MS,
    buildTikTokProbeEventId,
    buildTikTokProbePayload,
    buildTikTokProbeReference,
    buildTikTokProbeReport,
    isTikTokProbeAccepted,
    readTikTokProbeResponse,
} from "../lib/analytics/tiktok-events-api-probe";

const shouldSend = process.argv.includes("--send");

/**
 * Load the project's env files the way Next.js does (`.env.local`
 * overrides `.env`, existing shell variables always win).
 *
 * Must run BEFORE Prisma is imported: PrismaClient reads
 * DATABASE_URL when it is constructed, and tsx does not load .env
 * on its own.
 *
 * Production-style files are tried first because this script exists
 * to diagnose the production app; if that leaves DATABASE_URL
 * unset (e.g. it only lives in `.env.development`), the
 * development-style files are loaded as a fallback.
 *
 * Returns the loaded FILE NAMES only — never their contents.
 */
function loadProjectEnv(): string[] {
    const log = {
        info: () => {},
        error: () => {},
    };

    const production = loadEnvConfig(
        process.cwd(),
        false,
        log
    );

    if (process.env.DATABASE_URL) {
        return production.loadedEnvFiles.map(
            (file) => file.path
        );
    }

    const development = loadEnvConfig(
        process.cwd(),
        true,
        log,
        true
    );

    return development.loadedEnvFiles.map(
        (file) => file.path
    );
}

function line(label: string, value: string) {
    console.log(`  ${label.padEnd(28)} ${value}`);
}

function yesNo(value: boolean): string {
    return value ? "yes" : "NO";
}

async function main() {
    console.log(
        "\n━━━ ENVIRONMENT ━━━"
    );

    const envFiles = loadProjectEnv();

    line(
        "env files loaded",
        envFiles.length > 0
            ? envFiles.join(", ")
            : "none found"
    );
    line(
        "DATABASE_URL",
        process.env.DATABASE_URL
            ? "present (not printed)"
            : "MISSING"
    );
    line(
        "TIKTOK_TEST_EVENT_CODE",
        getTikTokTestEventCode()
            ? "visible to this process"
            : "not set / unusable"
    );

    console.log(
        "\n━━━ TIKTOK EVENTS API CONFIGURATION ━━━"
    );

    /*
     * A private, read-only client instead of lib/prisma: the app's
     * singleton switches on a development query log and caches
     * itself globally, neither of which belongs in a one-shot
     * diagnostic. The env files above are already loaded, so
     * DATABASE_URL is resolved exactly as the app resolves it.
     */
    const prisma = new PrismaClient({
        log: [],
    });

    let setting: {
        tiktokPixelEnabled: boolean;
        tiktokPixelId: string | null;
        tiktokPixelAccessToken: string | null;
    } | null = null;

    let readError: string | null = null;

    try {
        /*
         * Same row and same columns the application reads. Read
         * only — this script never writes.
         */
        setting =
            await prisma.storeSetting.findUnique({
                where: { id: 1 },
                select: {
                    tiktokPixelEnabled: true,
                    tiktokPixelId: true,
                    tiktokPixelAccessToken: true,
                },
            });
    } catch (error) {
        /*
         * Error CODE / name only: a driver message can embed the
         * database URL.
         */
        readError =
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof (error as { code?: unknown })
                .code === "string"
                ? (error as { code: string }).code
                : error instanceof Error
                  ? error.name
                  : "unknown";
    } finally {
        await prisma.$disconnect();
    }

    line(
        "endpoint",
        TIKTOK_EVENTS_API_ENDPOINT
    );
    line(
        "probe timeout",
        `${TIKTOK_PROBE_TIMEOUT_MS} ms`
    );
    line(
        "StoreSetting read",
        readError
            ? `FAILED (${readError})`
            : setting
              ? "ok"
              : "no row with id = 1"
    );

    const pixelId = setting
        ? normalizeTikTokPixelId(
              setting.tiktokPixelId
          )
        : null;

    const accessToken = setting
        ? normalizeTikTokPixelAccessToken(
              setting.tiktokPixelAccessToken
          )
        : null;

    const testEventCode = getTikTokTestEventCode();

    line(
        "tiktokPixelEnabled",
        setting
            ? yesNo(
                  setting.tiktokPixelEnabled ===
                      true
              )
            : "unknown"
    );
    /*
     * The Pixel ID is public (it ships in the storefront base code),
     * so it is printed. The Access Token never is.
     */
    line(
        "pixel id",
        pixelId
            ? pixelId
            : setting?.tiktokPixelId
              ? "PRESENT but INVALID (fails the Pixel ID format)"
              : "MISSING"
    );
    line(
        "access token",
        accessToken
            ? `present (${accessToken.length} chars)`
            : setting?.tiktokPixelAccessToken
              ? "PRESENT but INVALID (unusable characters)"
              : "MISSING"
    );
    line(
        "test_event_code",
        testEventCode
            ? `configured (${testEventCode.length} chars)`
            : "not configured"
    );

    const ready =
        readError === null &&
        setting !== null &&
        setting.tiktokPixelEnabled === true &&
        pixelId !== null &&
        accessToken !== null;

    console.log(
        `\n  verdict: ${
            ready
                ? "the sender WOULD make a request"
                : "the sender would SKIP (see the reason above)"
        }`
    );

    if (!testEventCode) {
        console.log(
            "  ⚠️  Without TIKTOK_TEST_EVENT_CODE the event is counted as REAL traffic."
        );
    }

    if (!shouldSend) {
        console.log(
            "\n  (add --send to also post one CompletePayment probe to TikTok)\n"
        );

        process.exitCode = readError ? 1 : 0;

        return;
    }

    if (!ready || !pixelId || !accessToken) {
        console.log(
            "\n  refusing to send: the configuration above is not usable.\n"
        );

        process.exitCode = 1;

        return;
    }

    const reference =
        buildTikTokProbeReference();
    const eventId =
        buildTikTokProbeEventId(reference);

    console.log(
        "\n━━━ LIVE PROBE (unique event id, no PII) ━━━"
    );
    line("reference", reference);

    const payload = buildTikTokProbePayload({
        pixelId,
        reference,
        eventId,
        testEventCode,
    });

    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        TIKTOK_PROBE_TIMEOUT_MS
    );

    try {
        const response = await fetch(
            TIKTOK_EVENTS_API_ENDPOINT,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                    /* SECRET — used here, never printed. */
                    [TIKTOK_EVENTS_API_TOKEN_HEADER]:
                        accessToken,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
                cache: "no-store",
            }
        );

        let body: unknown = null;

        try {
            body = await response.json();
        } catch {
            body = null;
        }

        const parsed =
            readTikTokProbeResponse(body);

        const accepted = isTikTokProbeAccepted(
            response.status,
            parsed
        );

        const report = buildTikTokProbeReport({
            reference,
            eventId,
            accepted,
            status: response.status,
            response: parsed,
            testEventCodeConfigured:
                testEventCode !== null,
        });

        console.log("\n  result:");
        for (const [key, value] of Object.entries(
            report
        )) {
            line(key, String(value ?? "—"));
        }

        if (!accepted) {
            console.log(
                "\n  → Quote status, code, message and request_id above when escalating to TikTok.\n"
            );
        }

        process.exitCode = accepted ? 0 : 1;
    } catch (error) {
        console.error(
            "\n  probe request failed:",
            error instanceof Error
                ? error.name
                : "unknown"
        );

        process.exitCode = 1;
    } finally {
        clearTimeout(timeout);
    }
}

main().catch((error) => {
    console.error(
        "TIKTOK EVENTS API CHECK FAILED:",
        error instanceof Error
            ? error.name
            : "unknown"
    );

    process.exitCode = 1;
});
