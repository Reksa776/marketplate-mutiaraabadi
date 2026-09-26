"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";

import {
    isAdminPath,
    trackTikTokUserMatch,
    whenTikTokPixelReady,
    type TikTokUserMatchIdentifiers,
} from "@/lib/analytics/tiktok";
import { settleTikTokIdentity } from "@/lib/analytics/tiktok-identity";

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
 *   So this component hands the Pixel identify API the NORMALIZED
 *   RAW values (email / phone_number / external_id) returned by
 *   `/api/analytics/tiktok-match`; it never sends a pre-computed
 *   digest (which the Pixel would hash again). The server-side
 *   Events API keeps its SHA-256 behavior.
 *
 * ORDERING:
 *   Once identity has been applied — or an anonymous / disabled /
 *   admin visitor has been settled — `settleTikTokIdentity()` is
 *   called. Event components wait on that signal
 *   (`whenTikTokReadyForEvents`) so authenticated events carry
 *   identity deterministically, while anonymous visitors are never
 *   blocked.
 *
 * SAFETY:
 *   - the Pixel's identify call sends NO event by itself, so
 *     PageView is never duplicated.
 *   - only runs when the Pixel is enabled, and never on /admin.
 *   - the lookup happens once per full page load (module-level
 *     promise cache) and is best-effort: any failure means "no
 *     matching data", never a broken page.
 */

type BrowserMatchData = {
    email?: unknown;
    phone_number?: unknown;
    external_id?: unknown;
};

/**
 * One in-flight (or already resolved) lookup per full page load.
 * SPA navigations reuse it, so matching keys never cost a request
 * per route change.
 */
let browserMatchPromise: Promise<BrowserMatchData> | null =
    null;

function loadBrowserMatch(): Promise<BrowserMatchData> {
    if (!browserMatchPromise) {
        browserMatchPromise = (async () => {
            try {
                const response = await fetch(
                    "/api/analytics/tiktok-match",
                    {
                        cache: "no-store",
                        credentials: "same-origin",
                    }
                );

                if (!response.ok) {
                    return {};
                }

                const body = (await response.json()) as {
                    data?: BrowserMatchData;
                };

                return body?.data ?? {};
            } catch {
                /*
                 * Tracking must never surface an error to the
                 * customer or the console.
                 */
                return {};
            }
        })();
    }

    return browserMatchPromise;
}

function readString(value: unknown): string | undefined {
    return typeof value === "string" && value
        ? value
        : undefined;
}

/**
 * Map the endpoint's normalized payload onto TikTok's
 * `identify()` names. Returns null when there is nothing usable.
 */
function toIdentifiers(
    data: BrowserMatchData
): TikTokUserMatchIdentifiers | null {
    const identifiers: TikTokUserMatchIdentifiers =
        {};

    const email = readString(data.email);

    if (email) {
        identifiers.email = email;
    }

    const phone = readString(data.phone_number);

    if (phone) {
        identifiers.phone_number = phone;
    }

    const externalId = readString(data.external_id);

    if (externalId) {
        identifiers.external_id = externalId;
    }

    return Object.keys(identifiers).length > 0
        ? identifiers
        : null;
}

export default function TikTokAdvancedMatching({
    enabled,
}: {
    enabled: boolean;
}) {
    const pathname = usePathname();
    const { status } = useSession();

    const identifiersRef =
        useRef<TikTokUserMatchIdentifiers | null>(
            null
        );

    const appliedRef = useRef(false);
    const startedRef = useRef(false);

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
            settleTikTokIdentity(null);
            return;
        }

        let cancelled = false;

        /**
         * Registers the keys once, and only once the Pixel is able
         * to accept them. Whichever resolves first — the lookup or
         * the Pixel — this ends up applied, and identity is only
         * settled after the identify call has been accepted.
         */
        const apply = () => {
            const identifiers =
                identifiersRef.current;

            if (appliedRef.current) {
                return;
            }

            if (!identifiers) {
                settleTikTokIdentity(null);
                return;
            }

            if (
                trackTikTokUserMatch(identifiers)
            ) {
                appliedRef.current = true;
                settleTikTokIdentity(identifiers);
            }
        };

        /* Path A: the Pixel becomes available. */
        const cancel = whenTikTokPixelReady(apply);

        /* Path B: the identity lookup resolves. */
        if (!startedRef.current) {
            startedRef.current = true;

            loadBrowserMatch().then((data) => {
                if (cancelled) {
                    return;
                }

                identifiersRef.current =
                    toIdentifiers(data);

                apply();
            });
        } else {
            apply();
        }

        return () => {
            cancelled = true;
            cancel();
        };
    }, [active, status]);

    return null;
}
