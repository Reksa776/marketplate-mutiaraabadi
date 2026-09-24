"use client";

import { useEffect } from "react";
import {
    buildTikTokEventId,
    trackTikTokEvent,
} from "@/lib/analytics/tiktok";

type PurchaseItem = {
    content_id: string;
    content_type: string;
    content_name: string;
    quantity: number;
    price: number;
};

type PurchaseTrackerProps = {
    orderId: string;
    total: number;
    currency?: string;
    contents?: PurchaseItem[];
};

/**
 * Fires TikTok Purchase event on mount.
 *
 * Use this inside a page to track completed
 * purchases without duplicating events.
 */
export default function PurchaseTracker({
    orderId,
    total,
    currency = "IDR",
    contents,
}: PurchaseTrackerProps) {
    useEffect(() => {
        trackTikTokEvent(
            "CompletePayment",
            {
                content_id: orderId,
                value: total,
                currency,
                contents: contents ?? [],
            },
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
    }, [orderId, total, currency, contents]);

    return null;
}
