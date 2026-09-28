import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
    buildTikTokBrowserMatch,
    isTikTokMatchDigest,
    type TikTokBrowserMatch,
} from "@/lib/analytics/tiktok-user-match";

/**
 * ==========================================
 * TIKTOK ADVANCED MATCHING — BROWSER KEYS
 * ==========================================
 *
 * Hands the logged-in browser the SHA-256 DIGESTS it passes to
 * `ttq.identify()`.
 *
 * WHY DIGESTS (verified against TikTok's shipped pixel source):
 *   The browser Pixel accepts either a raw value or an already
 *   hashed digest — its `Identify` plugin does
 *   `isHash(l) ? l : sha256(...)` for `email` and `phone_number`.
 *   We send the digest, which is what TikTok ends up receiving
 *   either way, and it is the only variant that keeps raw PII out
 *   of the client entirely AND keeps `external_id` identical to
 *   the server Events API channel (the Pixel does not hash
 *   `external_id`, so a raw id from the browser would never match
 *   the SHA-256 external_id the server sends).
 *
 * GUARANTEES:
 *   - authenticated: an anonymous caller always gets `{}`
 *   - the caller only ever receives their OWN data (session id)
 *   - the response contains ONLY 64-char SHA-256 digests — never
 *     a raw email, phone, password, token, or payment detail
 *   - normalization + hashing use the SAME helpers as the server
 *     Events API path, so both channels describe the same person
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

/**
 * Last line of defence before anything leaves the server.
 *
 * Drops any key whose value is not a well-formed SHA-256 digest,
 * so a raw email / phone number can never reach the client even if
 * the builder above were changed or fed unexpected data. Returns
 * null when nothing survives, which the caller turns into `{}`.
 */
function digestOnly(
    match: TikTokBrowserMatch
): TikTokBrowserMatch | null {
    const safe: TikTokBrowserMatch = {};

    for (const key of [
        "email",
        "phone_number",
        "external_id",
    ] as const) {
        if (isTikTokMatchDigest(match[key])) {
            safe[key] = match[key];
        }
    }

    return Object.keys(safe).length > 0 ? safe : null;
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

        const match = digestOnly(
            buildTikTokBrowserMatch({
                email: user.email,
                phone: user.phone,
                externalId: userId,
            })
        );

        if (!match) {
            return emptyMatchResponse();
        }

        return NextResponse.json(
            {
                success: true,
                data: match,
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
