"use client";

import { useEffect } from "react";
import {
    buildTikTokEventId,
    trackTikTokEvent,
    trackTikTokUserMatch,
    type TikTokUserMatchIdentifiers,
} from "@/lib/analytics/tiktok";
import {
    upgradeTikTokIdentity,
    whenTikTokReadyForEvents,
} from "@/lib/analytics/tiktok-identity";
import {
    buildTikTokOrderProperties,
    type TikTokCatalogItemInput,
} from "@/lib/analytics/tiktok-catalog";

type PurchaseTrackerProps = {
    orderId: string;
    total: number;
    /**
     * Authoritative order lines. Each one becomes its own
     * `contents[]` entry so TikTok can match the conversion against
     * the catalog — an order number is never used as a product id.
     */
    items?: TikTokCatalogItemInput[];
    /**
     * AUTHORITATIVE Advanced Matching digests built on the server
     * from `Order → User` (email / phone / external_id). Every value
     * is already a SHA-256 hex digest, so no raw PII reaches the
     * browser and nothing here is re-hashed.
     *
     * Absent for an order whose user genuinely has no email/phone —
     * in that case the event is still sent, without identity.
     */
    identity?: TikTokUserMatchIdentifiers | null;
};

/**
 * Fire the TikTok CompletePayment event with the event's
 * `properties` (value/currency/order_id/contents) and, when
 * available, the AUTHORITATIVE customer identity.
 *
 * WHY THIS IS A SEPARATE, EXPORTED FUNCTION:
 *   The browser CompletePayment used to rely only on the shared,
 *   session-driven identity store. On a post-redirect confirmation
 *   page that store could settle as ANONYMOUS (session / matching
 *   lookup timing, or an `ttq.identify` retry budget that ran out),
 *   so Purchase reached TikTok with neither `email` nor
 *   `phone_number` even though the order's user had both in the
 *   database.
 *
 *   Here the identity is derived from the ORDER on the server and
 *   registered with the Pixel immediately before the event, so the
 *   customer's identifiers survive any session-hydration race.
 *
 * The digests are forwarded AS-IS (`trackTikTokUserMatch` only
 * accepts 64-char SHA-256 hex and never hashes again), keeping the
 * browser digest identical to the server Events API digest for the
 * same person.
 */
export function trackAuthoritativeTikTokPurchase({
    orderId,
    total,
    items,
    identity,
}: {
    orderId: string;
    total: number;
    items?: TikTokCatalogItemInput[];
    identity?: TikTokUserMatchIdentifiers | null;
}): void {
    /*
     * Authoritative Advanced Matching first. Registering identity
     * sends no event by itself, so this can never duplicate
     * PageView or CompletePayment. No usable key → no identify call
     * (never an empty object, never a fabricated value).
     */
    if (identity && Object.keys(identity).length > 0) {
        trackTikTokUserMatch(identity);

        /*
         * Raise the shared store too, so an event registered later in
         * this page load also sees the identifiers. Never downgrades.
         */
        upgradeTikTokIdentity(identity);
    }

    trackTikTokEvent(
        "CompletePayment",
        buildTikTokOrderProperties(items, {
            value: total,
            orderId,
        }),
        {
            /*
             * Shared dedup id — identical to the server-side
             * Events API CompletePayment event_id.
             */
            eventId: buildTikTokEventId(
                "CompletePayment",
                orderId
            ),
        }
    );
}

/**
 * Fires the TikTok CompletePayment event on mount.
 *
 * Use this inside the order confirmation page. The payload carries
 * the SAME deterministic event_id as the server-side Events API
 * copy fired by the payment webhook, so TikTok deduplicates the two
 * into one conversion.
 *
 * `currency` is not a prop on purpose: the store has exactly one
 * currency (lib/analytics/tiktok-catalog).
 */
export default function PurchaseTracker({
    orderId,
    total,
    items,
    identity,
}: PurchaseTrackerProps) {
    useEffect(() => {
        return whenTikTokReadyForEvents(() => {
            trackAuthoritativeTikTokPurchase({
                orderId,
                total,
                items,
                identity,
            });
        });
    }, [orderId, total, items, identity]);

    return null;
}
