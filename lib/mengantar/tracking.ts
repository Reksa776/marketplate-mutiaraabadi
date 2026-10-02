/*
 * ============================================================
 * MENGANTAR TRACKING — PRESENTATION MAPPING (PURE)
 * ============================================================
 *
 * Provider routing rule: `Order.shippingProvider` is the single
 * source of truth for which tracking backend serves an order.
 *
 *   MENGANTAR  → Mengantar `GET /order?tracking_id=` (via
 *                `getMengantarOrderByTracking`) — NEVER RajaOngkir.
 *   anything else / NULL → legacy RajaOngkir waybill tracking.
 *
 * This module is PURE (no prisma / no env / no network) so it is
 * safe to import from route handlers and tests. The route performs
 * the provider call and passes the result here.
 * ============================================================
 */

import type { MengantarOrderHistoryEntry } from "@/lib/mengantar";

export const MENGANTAR_TRACKING_MESSAGE =
    "Status tracking diperbarui melalui Mengantar.";

export type TrackingManifestEntry = {
    manifest_code: string;
    manifest_description: string;
    manifest_date: string;
    manifest_time: string;
    city_name: string;
    title: string;
};

export type MengantarTrackingOrderMeta = {
    shippingProvider: string | null;
    providerCourier: string | null;
    providerShipmentId: string | null;
    providerBatchId: string | null;
    shipmentStatus: string | null;
    shippingPaymentStatus: string | null;
    codAmount: number | null;
    shippingCourier: string | null;
    shippingService: string | null;
    trackingNumber: string | null;
};

export type MengantarTrackingFetch = {
    orderId: string | null;
    status: string | null;
    statusCategory: string | null;
    trackingNumber: string | null;
    history: MengantarOrderHistoryEntry[];
} | null;

/**
 * `Order.shippingProvider === "MENGANTAR"` decides the tracking
 * backend. Case-insensitive to stay tolerant of provider casing, but
 * `NULL`/unknown providers deliberately fall through to RajaOngkir
 * so legacy orders keep working.
 */
export function isMengantarOrder(
    shippingProvider: unknown
): boolean {
    return (
        typeof shippingProvider === "string" &&
        shippingProvider.trim().toUpperCase() === "MENGANTAR"
    );
}

/**
 * Map Mengantar `history[]` entries onto the waybill manifest shape
 * the admin/customer timeline already renders.
 */
export function mapMengantarHistoryToManifest(
    history: MengantarOrderHistoryEntry[] | null | undefined
): TrackingManifestEntry[] {
    if (!Array.isArray(history)) return [];

    return history.map((entry) => ({
        manifest_code: "MENGANTAR",
        manifest_description: String(
            entry?.desc ?? ""
        ).trim(),
        manifest_date: String(entry?.date ?? "").trim(),
        manifest_time: "",
        city_name: "",
        title: "",
    }));
}

/**
 * Normalize a Mengantar order + (optional) provider polling result
 * into the shared tracking response body. `fetched === null` means
 * the provider read failed or no resi exists yet — the caller still
 * returns a 200 with DB-persisted shipment state and a clear message,
 * never a RajaOngkir error and never a RajaOngkir fallback.
 */
export function buildMengantarTrackingData(
    order: MengantarTrackingOrderMeta,
    fetched: MengantarTrackingFetch
) {
    const courier =
        order.providerCourier ??
        order.shippingCourier ??
        null;

    const manifest = mapMengantarHistoryToManifest(
        fetched?.history
    );

    return {
        source: "MENGANTAR" as const,

        shipment: {
            provider: order.shippingProvider,
            providerCourier: order.providerCourier,
            providerShipmentId: order.providerShipmentId,
            providerBatchId: order.providerBatchId,
            shipmentStatus: order.shipmentStatus,
            shippingPaymentStatus:
                order.shippingPaymentStatus,
            codAmount: order.codAmount,
        },

        summary: {
            courier_code: courier,
            courier_name: courier,
            waybill_number:
                fetched?.trackingNumber ??
                order.trackingNumber ??
                null,
            service_code:
                order.shippingService ?? null,
            status: order.shipmentStatus ?? null,
        },

        details: null,
        deliveryStatus: null,
        manifest,
        delivered: order.shipmentStatus === "DELIVERED",
        message: MENGANTAR_TRACKING_MESSAGE,
        trackingAvailable: Boolean(
            fetched && manifest.length > 0
        ),
    };
}
