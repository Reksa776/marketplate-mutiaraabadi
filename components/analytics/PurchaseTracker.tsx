"use client";

import { useEffect } from "react";
import {
    buildTikTokEventId,
    trackTikTokEvent,
} from "@/lib/analytics/tiktok";
import { whenTikTokReadyForEvents } from "@/lib/analytics/tiktok-identity";
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
};

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
}: PurchaseTrackerProps) {
    useEffect(() => {
        return whenTikTokReadyForEvents(() => {
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
        });
    }, [orderId, total, items]);

    return null;
}
