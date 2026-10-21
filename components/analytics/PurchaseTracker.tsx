"use client";

import { useEffect } from "react";
import {
    buildTikTokEventId,
    isTikTokPixelReady,
    resolveTikTokBrowserPixelId,
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
import { claimPurchase } from "@/lib/analytics/purchase-claim";
import { trackMetaBrowserPurchase } from "@/lib/analytics/meta-browser";

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
    /**
     * Explicit Pixel ID override. Normal call sites omit it: the id is
     * resolved from the rendered base script (`data-pixel-id`), which
     * is the only place the browser receives it.
     */
    pixelId?: string | null;
};

/**
 * Fire the TikTok CompletePayment event ONCE per purchase, per tab.
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
 *   It is ALSO the single shared Purchase entry point for all three
 *   browser confirmation routes (`/checkout/payment/[id]`,
 *   `/checkout/payment-finish`, `/checkout/success`), which is where
 *   the duplicate guard belongs: one claim, not three.
 *
 * DUPLICATE GUARD:
 *   `claimPurchase()` is checked AFTER eligibility (the caller only
 *   calls this for a convertible order), AFTER the Pixel is actually
 *   available, and BEFORE any event is sent. A payment-finish page
 *   that re-polls, a React remount, or a navigation to another
 *   confirmation route finds the claim already taken and sends
 *   nothing.
 *
 *   The deterministic `event_id` below still exists, but it only
 *   deduplicates this event against the SERVER Events API copy. It is
 *   not a browser-side deduplication mechanism, so it can never
 *   replace the claim.
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
    pixelId,
}: {
    orderId: string;
    total: number;
    items?: TikTokCatalogItemInput[];
    identity?: TikTokUserMatchIdentifiers | null;
    pixelId?: string | null;
}): void {
    /* Meta browser Purchase is independent of TikTok being enabled. */
    trackMetaBrowserPurchase({ orderNumber: orderId, total });

    /*
     * No Pixel API → no event AND no claim. Claiming here would burn
     * the only attempt for this order while nothing was ever sent,
     * and the claim must never imply a delivery that did not happen.
     */
    if (!isTikTokPixelReady()) {
        return;
    }

    const claimed = claimPurchase({
        channel: "tiktok",
        pixelId:
            pixelId ??
            resolveTikTokBrowserPixelId(),
        orderNumber: orderId,
    });

    /*
     * Already emitted for this order + pixel in this tab (other
     * confirmation route, remount, reload). Stop before identify()
     * and before the event.
     */
    if (!claimed) {
        return;
    }

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
 * into one conversion. The shared purchase claim additionally makes
 * sure a remount or a second confirmation route cannot emit the
 * browser copy twice.
 *
 * `currency` is not a prop on purpose: the store has exactly one
 * currency (lib/analytics/tiktok-catalog).
 */
export default function PurchaseTracker({
    orderId,
    total,
    items,
    identity,
    pixelId,
}: PurchaseTrackerProps) {
    useEffect(() => {
        const trackMeta = () => trackMetaBrowserPurchase({ orderNumber: orderId, total });
        trackMeta();
        window.addEventListener("meta-pixel-ready", trackMeta);
        const cancelTikTokWait = whenTikTokReadyForEvents(() => {
            trackAuthoritativeTikTokPurchase({
                orderId,
                total,
                items,
                identity,
                pixelId,
            });
        });
        return () => {
            window.removeEventListener("meta-pixel-ready", trackMeta);
            cancelTikTokWait();
        };
    }, [orderId, total, items, identity, pixelId]);

    return null;
}
