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
 * CONTRACT (verified against TikTok's shipped pixel source):
 *   The browser Pixel accepts either a raw value or a SHA-256
 *   digest for `email` / `phone_number` (its Identify plugin does
 *   `isHash(v) ? v : sha256(...)`). We always send the DIGEST, so
 *   raw PII never reaches the client and `external_id` matches the
 *   server Events API channel — which the Pixel does NOT hash, so a
 *   raw id from the browser would never line up with it.
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
