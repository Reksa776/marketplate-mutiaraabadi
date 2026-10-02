"use client";

import { useEffect, useRef } from "react";
import {
    usePathname,
    useSearchParams,
} from "next/navigation";

import {
    isAdminPath,
    trackTikTokEvent,
} from "@/lib/analytics/tiktok";
import {
    shouldTrackTikTokPageView,
    tiktokPageViewSignature,
} from "@/lib/analytics/tiktok-pageview";
import { whenTikTokReadyForEvents } from "@/lib/analytics/tiktok-identity";

/**
 * ==========================================
 * TIKTOK PIXEL — PAGEVIEW (APPLICATION-CONTROLLED)
 * ==========================================
 *
 * WHY THIS COMPONENT EXISTS:
 *   PageView used to be fired by the admin base code (`ttq.page()`),
 *   queued synchronously at Pixel load — BEFORE the authenticated
 *   session resolved, before /api/analytics/tiktok-match, and before
 *   `ttq.identify(digests)`. PageView could therefore never carry
 *   Advanced Matching identity. The base-code `ttq.page()` is now
 *   stripped from the executable script (lib/analytics/tiktok-config)
 *   and PageView is emitted here instead.
 *
 * CONTRACT:
 *   - waits for `whenTikTokReadyForEvents()` — the SAME identity-ready
 *     gate every other event uses (identity applied first, then the
 *     Pixel can accept the event)
 *   - therefore an AUTHENTICATED visitor's PageView is dispatched AFTER
 *     `ttq.identify()`, so TikTok can attach the already-registered keys
 *   - an ANONYMOUS visitor still gets PageView: identity settles
 *     immediately as `null`, so no fabricated identifier is ever sent
 *   - exactly ONE PageView per navigation (pathname + search), never a
 *     duplicate from React Strict Mode, re-renders or hydration
 *   - never on /admin, never when the Pixel is disabled
 *
 * PRIVACY:
 *   - sends NO event properties, NO email/phone, NO user id, NO order
 *     id. Identity travels only through the existing `ttq.identify()`
 *     state (SHA-256 digests), exactly like every other event.
 *   - does NOT call /api/analytics/tiktok-match itself; it reuses the
 *     shared identity store owned by TikTokAdvancedMatching.
 *
 * The PageView event is browser-only, so it deliberately carries NO
 * `event_id`: there is no server-side copy to deduplicate against, and
 * a stable id would make TikTok suppress repeat visits to the same URL.
 */

export default function TikTokPageViewTracker({
    enabled,
}: {
    enabled: boolean;
}) {
    const pathname = usePathname();
    const searchParams = useSearchParams();

    /*
     * Last navigation we fired for. A ref (not state) so setting it
     * never triggers a re-render / effect loop.
     */
    const lastFiredRef = useRef<string | null>(null);

    const signature = tiktokPageViewSignature(
        pathname,
        searchParams?.toString() ?? ""
    );

    useEffect(() => {
        /*
         * Never register a waiter (or its bounded timer) where we can
         * never fire: disabled pixel or admin dashboard.
         */
        if (!enabled || isAdminPath(pathname)) {
            return;
        }

        /*
         * Fire at most once per navigation. The ref is only written
         * INSIDE the callback, so a cancelled registration (React
         * Strict Mode's first mount) never marks the navigation as
         * fired — the second mount still fires exactly once.
         */
        return whenTikTokReadyForEvents(() => {
            if (
                !shouldTrackTikTokPageView({
                    enabled,
                    pathname,
                    signature,
                    lastFiredSignature:
                        lastFiredRef.current,
                })
            ) {
                return;
            }

            lastFiredRef.current = signature;

            trackTikTokEvent("PageView");
        });
    }, [enabled, pathname, signature]);

    return null;
}
