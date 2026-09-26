"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { captureTikTokAttributionFromBrowser } from "@/lib/analytics/attribution";

/**
 * ==========================================
 * TIKTOK ATTRIBUTION CAPTURE (BROWSER)
 * ==========================================
 *
 * Persists TikTok click attribution into a first-party cookie as
 * soon as a landing carries it:
 *
 *   - `ttclid` from `?ttclid=...` on the landing URL (first touch
 *     wins, so a later internal navigation never overwrites it)
 *   - `_ttp` from TikTok's OWN cookie, when the browser already
 *     has it (never fabricated)
 *   - the first landing URL + referrer of the visit
 *
 * Runs on mount and on every route change so a `ttclid` that
 * arrives on a deep-linked page is still captured. It sends
 * nothing to TikTok and never logs; the server reads the cookie at
 * order-creation time.
 */
export default function TikTokAttribution() {
    const pathname = usePathname();

    useEffect(() => {
        captureTikTokAttributionFromBrowser();
    }, [pathname]);

    return null;
}
