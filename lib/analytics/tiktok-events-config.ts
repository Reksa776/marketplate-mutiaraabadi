import "server-only";

import { prisma } from "@/lib/prisma";

import { normalizeTikTokPixelId } from "@/lib/analytics/tiktok";
import { normalizeTikTokPixelAccessToken } from "@/lib/analytics/tiktok-access-token";

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

/**
 * ==========================================
 * TEST EVENT CODE (TikTok Events Manager)
 * ==========================================
 *
 * TikTok accepts at most one top-level `test_event_code` per
 * event/track request. It is a TESTING-ONLY tag: TikTok routes
 * those events to the "Test Events" view and does not use them
 * for reporting.
 *
 * This is therefore an operational switch, not store data:
 *   - it lives in the environment, NOT in StoreSetting
 *   - it is never exposed through NEXT_PUBLIC_* / the browser
 *   - leaving it unset keeps production exactly as before
 *
 * The code itself is not a credential (it is visible in Events
 * Manager), but it is still treated as an opaque single-line
 * token and never logged.
 */
export const TIKTOK_TEST_EVENT_CODE_ENV =
    "TIKTOK_TEST_EVENT_CODE";

/** Upper bound to reject absurd payloads (real codes are short, e.g. TEST68129). */
export const MAX_TIKTOK_TEST_EVENT_CODE_LENGTH = 64;

/**
 * Normalize a raw test event code.
 *
 * Returns null when the value is absent / blank / too long /
 * not a single opaque token line (whitespace or control
 * characters would corrupt the request or leak a malformed
 * value to TikTok).
 */
export function normalizeTikTokTestEventCode(
    value: unknown
): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const code = value.trim();

    if (!code) {
        return null;
    }

    if (
        code.length >
        MAX_TIKTOK_TEST_EVENT_CODE_LENGTH
    ) {
        return null;
    }

    if (!/^[A-Za-z0-9_-]+$/.test(code)) {
        return null;
    }

    return code;
}

/**
 * Resolve the configured test event code from the environment.
 *
 * Read at call time so a restart with/without the variable is
 * the only thing that toggles test mode. Fails closed (null)
 * for anything unusable.
 */
export function getTikTokTestEventCode(
    env: NodeJS.ProcessEnv = process.env
): string | null {
    return normalizeTikTokTestEventCode(
        env[TIKTOK_TEST_EVENT_CODE_ENV]
    );
}

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
