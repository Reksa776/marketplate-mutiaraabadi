"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";

import { isAdminPath } from "@/lib/analytics/tiktok";
import { settleTikTokIdentity } from "@/lib/analytics/tiktok-identity";
import { bootstrapTikTokBrowserIdentity } from "@/lib/analytics/tiktok-browser-identity";

/**
 * ==========================================
 * TIKTOK ADVANCED MATCHING (BROWSER)
 * ==========================================
 *
 * Manual Advanced Matching, the way TikTok supports it: register
 * the customer's identifiers through the Pixel's identify API
 * BEFORE the events, and let the Pixel attach them to every event
 * that follows.
 *
 * CONTRACT (verified — see PHASE_22 report):
 *   The browser Pixel hashes identifiers with SHA-256 CLIENT-SIDE.
 *   So the Pixel identify API receives the NORMALIZED RAW values
 *   (email / phone_number / external_id) returned by
 *   `/api/analytics/tiktok-match`; it never receives a pre-computed
 *   digest (which the Pixel would hash again). The server-side
 *   Events API keeps its SHA-256 behavior.
 *
 * ORDERING (owned by lib/analytics/tiktok-browser-identity):
 *     Pixel ready → matching data ready → ttq.identify →
 *     identity settled → eligible event
 *
 *   The component only decides WHETHER the visitor is eligible:
 *   authenticated, non-admin, pixel enabled. It settles the
 *   identity store as anonymous ("track normally, no fake keys")
 *   for everyone else, while an authenticated visitor is released
 *   only after their lookup has actually resolved.
 *
 * SAFETY:
 *   - the Pixel's identify call sends NO event by itself, so
 *     PageView is never duplicated.
 *   - never on /admin, and only when the Pixel is enabled.
 *   - the lookup is best-effort: any failure means "no matching
 *     data", never a broken page and never a blocked event.
 */

export default function TikTokAdvancedMatching({
    enabled,
}: {
    enabled: boolean;
}) {
    const pathname = usePathname();
    const { status } = useSession();

    const active =
        enabled &&
        status === "authenticated" &&
        !isAdminPath(pathname);

    useEffect(() => {
        /*
         * Give the session time to resolve before deciding a
         * visitor is anonymous: settling too early would make
         * authenticated events miss identity.
         */
        if (status === "loading") {
            return;
        }

        if (!active) {
            /*
             * Anonymous / disabled / admin: settle immediately so
             * tracking is never blocked. No fake keys are invented.
             */
            settleTikTokIdentity(null);
            return;
        }

        bootstrapTikTokBrowserIdentity();
    }, [active, status]);

    return null;
}
