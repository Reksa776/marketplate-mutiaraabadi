"use client";

import { claimPurchase } from "@/lib/analytics/purchase-claim";

export function trackMetaBrowserPurchase(input: { orderNumber: string; total: number }): void {
    if (typeof window === "undefined" || typeof window.fbq !== "function") return;
    const pixelId = document.getElementById("meta-pixel")?.getAttribute("data-pixel-id");
    if (!pixelId || !claimPurchase({ channel: "meta", pixelId, orderNumber: input.orderNumber })) return;
    const eventId = `meta:purchase:${input.orderNumber}`;
    window.fbq("track", "Purchase", {
        value: Number(input.total),
        currency: "IDR",
        order_id: input.orderNumber,
    }, { eventID: eventId });
}
