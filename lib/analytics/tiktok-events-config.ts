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
};

export const DISABLED_TIKTOK_EVENTS_API: TikTokEventsApiConfig = {
    enabled: false,
    pixelId: null,
    accessToken: null,
};

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
