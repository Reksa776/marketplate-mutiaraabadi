/**
 * ==========================================================
 * WHATSAPP AUTO-REPLY — TRACKING READER (READ-ONLY)
 * ==========================================================
 *
 * Answers "where is my parcel?" using EXACTLY the shipment integrations
 * the website already uses — no new courier provider, no second API
 * client, no scraping:
 *
 *   Order.shippingProvider === "MENGANTAR"
 *        → getMengantarOrderByTracking() + buildMengantarTrackingData()
 *          (lib/mengantar.ts / lib/mengantar/tracking.ts)
 *   anything else / NULL (legacy orders)
 *        → RajaOngkir waybill tracking, the same request shape as
 *          app/api/orders/[id]/tracking/route.ts
 *
 * GUARANTEES
 *
 *   * READ-ONLY. Nothing here writes an order, a shipment or a status,
 *     and nothing here can change what the customer sees in the admin
 *     panel. A tracking request is never a status change.
 *   * Never throws: a provider failure degrades to a view that says the
 *     newest update is unavailable, so the bot still answers with the
 *     last stored state instead of going silent.
 *   * Cheap: a short in-process cache absorbs repeated requests for the
 *     same order (customers tap "1" several times), and callers skip
 *     this module entirely for terminal shipments they do not need to
 *     re-poll.
 *   * The recipient phone is used ONLY as the RajaOngkir
 *     `last_phone_number` parameter (that API requires it). It is never
 *     logged and never returned in a view.
 */

import {
    getMengantarOrderByTracking,
} from "@/lib/mengantar";
import {
    buildMengantarTrackingData,
    isMengantarOrder,
} from "@/lib/mengantar/tracking";

export type TrackingHistoryEntry = {
    date: string;
    description: string;
};

export type TrackingView = {
    source: "MENGANTAR" | "RAJAONGKIR" | "NONE";
    /** A provider read was attempted for this view. */
    providerRead: boolean;
    /** The provider returned usable tracking data. */
    available: boolean;
    courier: string | null;
    trackingNumber: string | null;
    providerStatus: string | null;
    history: TrackingHistoryEntry[];
    /** Disclosure shown to the customer, e.g. when a read failed. */
    note: string | null;
};

/**
 * The order columns the reader needs. Structurally a subset of the
 * handler's order payload, so no shared type (and no import cycle) is
 * required.
 */
export type TrackingOrderInput = {
    id: number;
    shippingProvider: string | null;
    providerCourier: string | null;
    shippingCourier: string | null;
    shippingService: string | null;
    trackingNumber: string | null;
    shipmentStatus: string | null;
    /**
     * Recipient phone — RajaOngkir requires its last 5 digits for
     * waybill validation. Never printed, never returned.
     */
    phone?: string | null;
};

/** Shown whenever the provider could not be reached. */
export const TRACKING_UPDATE_UNAVAILABLE_NOTE =
    "Pembaruan terbaru dari ekspedisi belum tersedia saat ini; berikut status terakhir yang tersimpan.";

/** Provider reads are cached briefly to absorb repeated taps. */
export const TRACKING_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
    at: number;
    view: TrackingView;
};

/**
 * Per-process cache. The app runs as a SINGLE instance (PM2 fork mode,
 * instances: 1), so an in-process map cannot disagree with itself; even
 * if that changed, a stale entry costs at most one outdated read and
 * never a wrong status, because the reply composer labels provider data
 * as such.
 */
const trackingCache = new Map<number, CacheEntry>();

/** Test/ops hook: drop every cached provider read. */
export function resetTrackingCache(): void {
    trackingCache.clear();
}

function emptyView(
    overrides: Partial<TrackingView> = {}
): TrackingView {
    return {
        source: "NONE",
        providerRead: false,
        available: false,
        courier: null,
        trackingNumber: null,
        providerStatus: null,
        history: [],
        note: null,
        ...overrides,
    };
}

/**
 * Load the current tracking view for an order.
 *
 * @param options.useCache  false forces a fresh provider read (used by
 *                          the explicit "Lihat Riwayat Pengiriman"
 *                          action so a terminal state can still be
 *                          refreshed on demand).
 */
export async function loadTrackingView(
    order: TrackingOrderInput,
    options: { useCache?: boolean; now?: number } = {}
): Promise<TrackingView> {
    const useCache = options.useCache !== false;
    const now = options.now ?? Date.now();

    if (useCache) {
        const cached = trackingCache.get(order.id);

        if (cached && now - cached.at < TRACKING_CACHE_TTL_MS) {
            return cached.view;
        }
    }

    const view = await readFromProvider(order);

    trackingCache.set(order.id, { at: now, view });

    return view;
}

async function readFromProvider(
    order: TrackingOrderInput
): Promise<TrackingView> {
    try {
        if (isMengantarOrder(order.shippingProvider)) {
            return await readMengantar(order);
        }

        return await readRajaOngkir(order);
    } catch (error) {
        /*
         * Never let a provider problem escape: the customer must get the
         * last known state plus an honest note.
         */
        console.error(
            "[WHATSAPP BOT] Tracking read failed | order:",
            order.id,
            "|",
            error instanceof Error ? error.message : error
        );

        return emptyView({
            source: isMengantarOrder(order.shippingProvider)
                ? "MENGANTAR"
                : "RAJAONGKIR",
            providerRead: true,
            courier:
                order.providerCourier ??
                order.shippingCourier ??
                null,
            trackingNumber: order.trackingNumber,
            providerStatus: order.shipmentStatus,
            note: TRACKING_UPDATE_UNAVAILABLE_NOTE,
        });
    }
}

/**
 * MENGANTAR: reused verbatim through the shared mapper, so the bot and
 * the order page can never disagree about what the provider said.
 */
async function readMengantar(
    order: TrackingOrderInput
): Promise<TrackingView> {
    if (!order.trackingNumber) {
        return emptyView({
            source: "MENGANTAR",
            courier: order.providerCourier,
            providerStatus: order.shipmentStatus,
        });
    }

    const fetched = await getMengantarOrderByTracking(
        order.trackingNumber
    );

    if (!fetched) {
        return emptyView({
            source: "MENGANTAR",
            providerRead: true,
            courier: order.providerCourier,
            trackingNumber: order.trackingNumber,
            providerStatus: order.shipmentStatus,
            note: TRACKING_UPDATE_UNAVAILABLE_NOTE,
        });
    }

    const data = buildMengantarTrackingData(
        {
            shippingProvider: order.shippingProvider,
            providerCourier: order.providerCourier,
            providerShipmentId: null,
            providerBatchId: null,
            shipmentStatus: order.shipmentStatus,
            shippingPaymentStatus: null,
            codAmount: null,
            shippingCourier: order.shippingCourier,
            shippingService: order.shippingService,
            trackingNumber: order.trackingNumber,
        },
        {
            orderId: fetched.orderId,
            status: fetched.status,
            statusCategory: fetched.statusCategory,
            trackingNumber: fetched.trackingNumber,
            history: fetched.history,
        }
    );

    const manifest = Array.isArray(data.manifest)
        ? data.manifest
        : [];

    return {
        source: "MENGANTAR",
        providerRead: true,
        available: Boolean(data.trackingAvailable),
        courier: data.summary.courier_name,
        trackingNumber: data.summary.waybill_number,
        providerStatus: fetched.statusCategory ?? fetched.status,
        history: manifest.map((entry) => ({
            date: String(entry.manifest_date ?? "").trim(),
            description: String(
                entry.manifest_description ??
                    entry.title ??
                    ""
            ).trim(),
        })),
        note: null,
    };
}

/**
 * RAJAONGKIR (legacy orders).
 *
 * This mirrors the request already proven in
 * app/api/orders/[id]/tracking/route.ts (POST /track/v1/waybill with
 * `awb`, `courier` and `last_phone_number`). It is deliberately a small
 * local implementation rather than a refactor of that production route,
 * so the existing customer tracking page keeps byte-for-byte behaviour.
 */
async function readRajaOngkir(
    order: TrackingOrderInput
): Promise<TrackingView> {
    if (!order.trackingNumber) {
        return emptyView({
            source: "RAJAONGKIR",
            courier: order.shippingCourier,
        });
    }

    const apiKey = process.env.RAJAONGKIR_API_KEY;

    if (!apiKey) {
        return emptyView({
            source: "RAJAONGKIR",
            providerRead: true,
            courier: order.shippingCourier,
            trackingNumber: order.trackingNumber,
            providerStatus: order.shipmentStatus,
            note: "Pembaruan ekspedisi belum dikonfigurasi; berikut status terakhir yang tersimpan.",
        });
    }

    const phoneDigits = String(order.phone ?? "").replace(
        /\D/g,
        ""
    );
    const lastPhoneNumber = phoneDigits.slice(-5);

    if (!order.shippingCourier || lastPhoneNumber.length !== 5) {
        return emptyView({
            source: "RAJAONGKIR",
            providerRead: true,
            courier: order.shippingCourier,
            trackingNumber: order.trackingNumber,
            providerStatus: order.shipmentStatus,
            note: TRACKING_UPDATE_UNAVAILABLE_NOTE,
        });
    }

    const url = new URL(
        "https://rajaongkir.komerce.id/api/v1/track/waybill"
    );

    url.searchParams.set("awb", order.trackingNumber);
    url.searchParams.set(
        "courier",
        normalizeCourier(order.shippingCourier)
    );
    url.searchParams.set("last_phone_number", lastPhoneNumber);

    const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
            key: apiKey,
            Accept: "application/json",
        },
        cache: "no-store",
    });

    const result = await response.json().catch(() => null);

    if (
        !response.ok ||
        result?.meta?.status !== "success" ||
        !result?.data
    ) {
        return emptyView({
            source: "RAJAONGKIR",
            providerRead: true,
            courier: order.shippingCourier,
            trackingNumber: order.trackingNumber,
            providerStatus: order.shipmentStatus,
            note: TRACKING_UPDATE_UNAVAILABLE_NOTE,
        });
    }

    const manifest = Array.isArray(result.data.manifest)
        ? result.data.manifest
        : [];

    return {
        source: "RAJAONGKIR",
        providerRead: true,
        available: manifest.length > 0,
        courier: order.shippingCourier,
        trackingNumber: order.trackingNumber,
        providerStatus:
            result.data?.delivery_status ?? null,
        history: manifest.map(
            (entry: Record<string, unknown>) => ({
                date: [
                    entry?.manifest_date,
                    entry?.manifest_time,
                ]
                    .filter(Boolean)
                    .join(" ")
                    .trim(),
                description: String(
                    entry?.manifest_description ??
                        entry?.title ??
                        ""
                ).trim(),
            })
        ),
        note: null,
    };
}

/** Same courier-code normalization the tracking route applies. */
function normalizeCourier(courier: string): string {
    const value = String(courier ?? "")
        .toLowerCase()
        .trim();

    if (
        value === "jnt" ||
        value === "j&t" ||
        value.includes("jnt")
    ) {
        return "jnt";
    }

    if (value.includes("jne")) return "jne";
    if (value.includes("sicepat")) return "sicepat";
    if (value.includes("anteraja")) return "anteraja";
    if (value.includes("pos")) return "pos";
    if (value.includes("tiki")) return "tiki";
    if (value.includes("ninja")) return "ninja";
    if (value.includes("idexpress")) return "idexpress";

    return value;
}
