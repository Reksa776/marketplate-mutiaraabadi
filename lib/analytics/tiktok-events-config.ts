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
};

export const DISABLED_TIKTOK_EVENTS_API: TikTokEventsApiConfig = {
    enabled: false,
    pixelId: null,
    accessToken: null,
    testEventCode: null,
};

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
        };
    } catch (error) {
        /*
         * Fail closed: no config, no request. Never log the
         * token (it is not part of the error).
         */
        console.error(
            "GET TIKTOK EVENTS API CONFIG ERROR:",
            error
        );

        return { ...DISABLED_TIKTOK_EVENTS_API };
    }
}
