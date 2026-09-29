import "server-only";

import { prisma } from "@/lib/prisma";

import { normalizeTikTokPixelId } from "@/lib/analytics/tiktok";
import { normalizeTikTokPixelAccessToken } from "@/lib/analytics/tiktok-access-token";
import { getTikTokTestEventCode } from "@/lib/analytics/tiktok-test-event-code";

/**
 * ==========================================
 * TIKTOK EVENTS API — SERVER CONFIG
 * ==========================================
 *
 * Resolves the server-side TikTok Events API configuration.
 *
 * IMPORTANT:
 *   - This module is `server-only` on purpose. It reads the
 *     Access Token (a SECRET) from StoreSetting.
 *   - It must NEVER be imported by a client component.
 *   - The returned token must NEVER be forwarded to the
 *     browser, logged, or embedded in any HTTP response.
 *
 * Read failures (e.g. column not yet migrated, DB down) resolve
 * to a DISABLED config so callers simply skip tracking instead
 * of throwing.
 */
export type TikTokEventsApiConfig = {
    enabled: boolean;
    pixelId: string | null;
    accessToken: string | null;
    /**
     * TikTok Events Manager test code. When set, server-side
     * events are tagged with `test_event_code` so they show up
     * in the "Test Events" view instead of normal reporting.
     *
     * OPT-IN ONLY, resolved from an environment variable (never
     * the database, never a NEXT_PUBLIC_* value). Production
     * behaviour is unchanged while the variable is absent.
     */
    testEventCode: string | null;
    /**
     * Set ONLY when the configuration could not be read at all
     * (missing column, database down). It carries a short, opaque
     * error code — never a message, never the token.
     *
     * Without it a failed read is indistinguishable from a store
     * that deliberately left the pixel off, which makes a silent
     * "no request was sent" impossible to explain in production.
     */
    unavailableReason: string | null;
};

export const DISABLED_TIKTOK_EVENTS_API: TikTokEventsApiConfig = {
    enabled: false,
    pixelId: null,
    accessToken: null,
    testEventCode: null,
    unavailableReason: null,
};

/**
 * Short, non-sensitive code describing why a config read failed.
 *
 * Prisma exposes a stable string `code` (e.g. P2021/P2022 for a
 * missing table/column); anything else falls back to the error
 * class name. The message is deliberately NOT forwarded — it can
 * embed the connection string.
 */
function tiktokConfigErrorCode(
    error: unknown
): string {
    if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof (error as { code?: unknown }).code ===
            "string" &&
        (error as { code: string }).code
    ) {
        return (error as { code: string }).code;
    }

    return error instanceof Error
        ? error.name
        : "unknown";
}

/*
 * ==========================================
 * TEST EVENT CODE (TikTok Events Manager)
 * ==========================================
 *
 * The rule itself lives in lib/analytics/tiktok-test-event-code.ts,
 * which is deliberately NOT `server-only` so standalone Node/tsx
 * tooling can apply the exact same rule as the application (see
 * that module's header). It is re-exported here so this module's
 * public API — and every existing importer — stays unchanged.
 */
export {
    TIKTOK_TEST_EVENT_CODE_ENV,
    MAX_TIKTOK_TEST_EVENT_CODE_LENGTH,
    normalizeTikTokTestEventCode,
    getTikTokTestEventCode,
} from "@/lib/analytics/tiktok-test-event-code";

export async function getTikTokEventsApiConfig(): Promise<TikTokEventsApiConfig> {
    try {
        const setting =
            await prisma.storeSetting.findUnique({
                where: { id: 1 },
                select: {
                    tiktokPixelEnabled: true,
                    tiktokPixelId: true,
                    tiktokPixelAccessToken: true,
                },
            });

        if (!setting) {
            return { ...DISABLED_TIKTOK_EVENTS_API };
        }

        return {
            enabled:
                setting.tiktokPixelEnabled === true,
            pixelId: normalizeTikTokPixelId(
                setting.tiktokPixelId
            ),
            accessToken: normalizeTikTokPixelAccessToken(
                setting.tiktokPixelAccessToken
            ),
            /*
             * Test mode is orthogonal to the stored pixel
             * config: the access token still comes from
             * StoreSetting, only the test tag comes from env.
             */
            testEventCode: getTikTokTestEventCode(),
            unavailableReason: null,
        };
    } catch (error) {
        /*
         * Fail closed: no config, no request. Never log the
         * token (it is not part of the error).
         */
        const unavailableReason =
            tiktokConfigErrorCode(error);

        console.error(
            "GET TIKTOK EVENTS API CONFIG ERROR:",
            unavailableReason
        );

        return {
            ...DISABLED_TIKTOK_EVENTS_API,
            unavailableReason,
            /*
             * The test code lives in the environment, not the
             * database, so it is still resolvable here. Keeping
             * it lets the skip log prove whether the process
             * actually sees TIKTOK_TEST_EVENT_CODE even when the
             * settings row could not be read.
             */
            testEventCode: getTikTokTestEventCode(),
        };
    }
}
