import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { buildTikTokBrowserMatch } from "@/lib/analytics/tiktok-user-match";

/**
 * ==========================================
 * TIKTOK ADVANCED MATCHING — BROWSER KEYS
 * ==========================================
 *
 * Hands the logged-in browser the NORMALIZED identifiers it passes
 * to `ttq.identify()`.
 *
 * WHY RAW (documented contract — see PHASE_22 report):
 *   TikTok's browser Pixel hashes customer identifiers with
 *   SHA-256 client-side before they reach TikTok servers. The
 *   documented contract for `ttq.identify()` is therefore the
 *   normalized RAW value; sending a pre-computed digest would be
 *   hashed a second time and match nobody.
 *
 *   The server-side Events API is unchanged and still receives
 *   SHA-256 digests (lib/analytics/tiktok-user-match →
 *   `buildTikTokUserMatch`).
 *
 * GUARANTEES:
 *   - authenticated: an anonymous caller always gets `{}`
 *   - the caller only ever receives their OWN data (session id)
 *   - normalization uses the SAME helpers as the server path, so
 *     both channels describe the same person
 *   - missing / invalid data is omitted, never sent as an empty
 *     string or a fabricated placeholder
 *   - never cached (`no-store`), never logged
 *   - read failures degrade to `{}` instead of an error; tracking
 *     is best-effort and must never break a page
 */

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
    "Cache-Control":
        "no-store, no-cache, must-revalidate",
} as const;

/** Empty result: nothing usable to match against. */
function emptyMatchResponse() {
    return NextResponse.json(
        {
            success: true,
            data: {},
        },
        {
            headers: NO_STORE_HEADERS,
        }
    );
}

export async function GET() {
    try {
        const session = await auth();

        const userId =
            session?.user &&
            typeof (session.user as { id?: unknown })
                .id === "string"
                ? ((session.user as { id: string })
                      .id)
                : null;

        if (!userId) {
            return emptyMatchResponse();
        }

        /*
         * The database is the source of truth (the session carries
         * no phone number). Only these two columns are read, and
         * the values are normalized — never returned to any other
         * visitor, never logged.
         */
        const user =
            await prisma.user.findUnique({
                where: { id: userId },
                select: {
                    email: true,
                    phone: true,
                },
            });

        if (!user) {
            return emptyMatchResponse();
        }

        return NextResponse.json(
            {
                success: true,
                data: buildTikTokBrowserMatch({
                    email: user.email,
                    phone: user.phone,
                    externalId: userId,
                }),
            },
            {
                headers: NO_STORE_HEADERS,
            }
        );
    } catch {
        /*
         * Never throw and never log the payload: a failure just
         * means "no matching data for this visitor".
         */
        return emptyMatchResponse();
    }
}
