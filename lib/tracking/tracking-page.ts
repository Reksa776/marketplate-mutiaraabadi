/**
 * ==========================================
 * PUBLIC TRACKING PAGE — PURE LOGIC
 * ==========================================
 *
 * Everything the `/lacak` page needs to decide BEFORE it renders, kept
 * out of the components so it can be unit tested without a DOM and
 * without a network:
 *
 *   * how the `?pesanan=` prefill hint is read,
 *   * how the page finds the customer's own order among the orders the
 *     browser is ALREADY authorized to see,
 *   * whether a provider read is worth doing at all,
 *   * which shipment stage the stored order state maps to,
 *   * how a provider payload is normalized (both couriers).
 *
 * SECURITY CONTRACT
 *
 *   `orderNumber` is a PREFILL HINT. It is never proof of ownership and
 *   nothing here reads an order by it: `findAccessibleOrder` only ever
 *   searches the list that `GET /api/orders` returned, which is itself
 *   scoped to the guest access token cookie (or the session). A guessed
 *   or forwarded order number therefore yields null, and the caller
 *   falls back to the two-phase OTP recovery.
 *
 *   The normalized view exposes ONLY shipment facts — no address, phone,
 *   email, item, total, payment instruction or token field can appear
 *   here, by construction.
 */

/** Mirrors the order-number length used elsewhere in the app. */
export const TRACKING_PREFILL_MAX_LENGTH = 40;

/** The prefill query parameter (shared with the WhatsApp link builder). */
export const TRACKING_ORDER_PARAM = "pesanan";

/** Shown when the courier could not be reached for the newest update. */
export const TRACKING_UPDATE_UNAVAILABLE_NOTE =
    "Pembaruan terbaru dari ekspedisi belum tersedia saat ini; berikut status terakhir yang tersimpan.";

export type AccessibleOrderLike = {
    id: number;
    orderNumber: string;
};

export type TrackingOrderLike = {
    id?: number;
    status: string;
    paymentStatus?: string;
    shippingProvider: string | null;
    trackingNumber: string | null;
    shipmentStatus: string | null;
};

export type ShipmentTimelineEntry = {
    date: string;
    description: string;
    location: string | null;
};

/**
 * Shipment stage of the STORED order state. The page renders a badge, a
 * hint and (for terminal stages) an explanation from this single value.
 */
export type ShipmentStage =
    | "CANCELLED"
    | "DELETED"
    | "RETURNED"
    | "UNDELIVERED"
    | "DELIVERED"
    | "COMPLETED"
    | "IN_TRANSIT"
    | "AWAITING_PICKUP"
    | "AWAITING_HANDOVER"
    | "AWAITING_PAYMENT"
    | "PREPARING";

/**
 * Read the prefill hint from the query string.
 *
 * Kept deliberately conservative: trimmed, length-capped and restricted
 * to the characters an order number may contain, so a hostile value
 * cannot be reflected into the form (or into a link) verbatim.
 */
export function sanitizeOrderNumberParam(
    raw: unknown
): string | null {
    if (typeof raw !== "string") {
        return null;
    }

    const value = raw.trim();

    if (!value || value.length > TRACKING_PREFILL_MAX_LENGTH) {
        return null;
    }

    if (!/^[A-Za-z0-9-]+$/.test(value)) {
        return null;
    }

    return value;
}

/** Order numbers are compared without case or surrounding space. */
export function matchesOrderNumber(
    a: unknown,
    b: unknown
): boolean {
    if (typeof a !== "string" || typeof b !== "string") {
        return false;
    }

    const left = a.trim().toUpperCase();
    const right = b.trim().toUpperCase();

    return Boolean(left) && left === right;
}

/**
 * Find the order this browser may see, by order number.
 *
 * @param orders        EXACTLY what `GET /api/orders` returned.
 * @param orderNumber   the (untrusted) prefill hint.
 */
export function findAccessibleOrder<T extends AccessibleOrderLike>(
    orders: T[],
    orderNumber: string | null | undefined
): T | null {
    if (!Array.isArray(orders) || !orderNumber) {
        return null;
    }

    return (
        orders.find((order) =>
            matchesOrderNumber(order?.orderNumber, orderNumber)
        ) ?? null
    );
}

/**
 * Is a provider read worth doing?
 *
 * Mirrors the rule the order detail page already applies: a Mengantar
 * order has shipment state worth reading even BEFORE a resi exists,
 * while a legacy order without a resi has nothing to ask RajaOngkir
 * about — so no paid call is made for it.
 */
export function shouldReadProvider(
    order: Pick<
        TrackingOrderLike,
        "shippingProvider" | "trackingNumber"
    >
): boolean {
    if (order?.trackingNumber) {
        return true;
    }

    return (
        String(order?.shippingProvider ?? "")
            .trim()
            .toUpperCase() === "MENGANTAR"
    );
}

/**
 * Customer-facing label per stage.
 *
 * Worded to agree with what the WhatsApp bot says for the same stored
 * state, so the two surfaces can never describe one parcel differently.
 */
export const SHIPMENT_STAGE_LABELS: Record<
    ShipmentStage,
    string
> = {
    CANCELLED: "Pesanan Dibatalkan",
    DELETED: "Data Pengiriman Dihapus",
    RETURNED: "Dikembalikan ke Pengirim",
    UNDELIVERED: "Gagal Diantar",
    DELIVERED: "Terkirim",
    COMPLETED: "Selesai",
    IN_TRANSIT: "Dalam Perjalanan",
    AWAITING_PICKUP: "Belum Diambil Kurir",
    AWAITING_HANDOVER: "Belum Diserahkan ke Ekspedisi",
    AWAITING_PAYMENT: "Menunggu Pembayaran",
    PREPARING: "Sedang Disiapkan",
};

/**
 * The one explanation a stage needs, when it needs one at all. States
 * only what the stored data actually says — never an estimate, never a
 * promise, never a claim that a parcel was received unless the courier
 * said so.
 */
export function shipmentStageHint(
    stage: ShipmentStage
): string | null {
    switch (stage) {
        case "AWAITING_PAYMENT":
            return "Pesanan belum dibayar, sehingga nomor resi belum tersedia.";

        case "AWAITING_HANDOVER":
            return "Paket belum diserahkan ke ekspedisi, sehingga nomor resi belum tersedia.";

        case "PREPARING":
            return "Pesanan sedang disiapkan. Nomor resi akan tampil setelah paket diserahkan ke ekspedisi.";

        case "CANCELLED":
            return "Pesanan ini sudah dibatalkan dan tidak memiliki pengiriman aktif.";

        case "DELETED":
            return "Data pengiriman pesanan ini tidak lagi tersedia. Hubungi admin untuk pengecekan lebih lanjut.";

        case "RETURNED":
            return "Ekspedisi menandai paket ini dikembalikan ke pengirim. Hubungi admin untuk tindak lanjut.";

        case "UNDELIVERED":
            return "Ekspedisi menandai paket ini gagal diantar. Hubungi admin agar dibantu penjadwalan ulang.";

        default:
            return null;
    }
}

/** Map the stored state onto one stage. Never guesses. */
export function resolveShipmentStage(
    order: TrackingOrderLike
): ShipmentStage {
    const orderStatus = String(order?.status ?? "").toUpperCase();
    const shipment = String(
        order?.shipmentStatus ?? ""
    ).toUpperCase();

    if (orderStatus === "CANCELLED" || shipment === "CANCELLED") {
        return "CANCELLED";
    }

    if (shipment === "DELETED") {
        return "DELETED";
    }

    if (shipment === "RETURNED") {
        return "RETURNED";
    }

    if (shipment === "UNDELIVERED") {
        return "UNDELIVERED";
    }

    if (shipment === "DELIVERED") {
        return "DELIVERED";
    }

    if (orderStatus === "COMPLETED") {
        return "COMPLETED";
    }

    /* Same statuses the bot reports as "Dalam Perjalanan". */
    if (shipment === "PICKED_UP" || shipment === "IN_TRANSIT") {
        return "IN_TRANSIT";
    }

    /* Created with the courier, not collected yet. */
    if (shipment === "CREATED" || shipment === "SHIPPING_PAID") {
        return "AWAITING_PICKUP";
    }

    if (
        shipment === "WAITING_SHIPPING_PAYMENT" ||
        shipment === "PAYING"
    ) {
        return "AWAITING_HANDOVER";
    }

    if (
        orderStatus === "PENDING" &&
        String(order?.paymentStatus ?? "").toUpperCase() !==
            "PAID"
    ) {
        return "AWAITING_PAYMENT";
    }

    return "PREPARING";
}

/**
 * Normalize a tracking payload into timeline entries.
 *
 * Accepts both provider shapes the existing API route returns (Mengantar
 * history and the RajaOngkir waybill manifest both expose
 * `manifest_date` / `manifest_time` / `manifest_description` /
 * `title` / `city_name`). Entries are returned NEWEST FIRST, because
 * that is how a customer reads a parcel's journey on a phone.
 */
export function normalizeTrackingManifest(
    manifest: unknown
): ShipmentTimelineEntry[] {
    if (!Array.isArray(manifest)) {
        return [];
    }

    return manifest
        .map((raw) => {
            const entry = (raw ?? {}) as Record<string, unknown>;

            const date = [
                entry.manifest_date,
                entry.manifest_time,
            ]
                .filter(
                    (value) =>
                        typeof value === "string" &&
                        value.trim()
                )
                .join(" ")
                .trim();

            const description = String(
                entry.manifest_description ??
                    entry.title ??
                    ""
            ).trim();

            const location = String(
                entry.city_name ?? ""
            ).trim();

            return {
                date,
                description,
                location: location || null,
            };
        })
        .filter(
            (entry) => entry.date || entry.description
        )
        .reverse();
}

/**
 * What the page may say about the NEWEST provider read.
 *
 * A failed read — an HTTP error (400/500), `success: false`, a body that
 * is not even json, or the request itself throwing — NEVER replaces the
 * stored state. It only raises an honest, additive note, so the customer
 * keeps seeing the last status that really exists instead of a raw error.
 */
export type ProviderReadResult =
    | { view: TrackingProviderView; note: false }
    | { view: null; note: true };

/**
 * Decide the provider outcome from the tracking endpoint's response.
 *
 * @param response  `{ ok, body }` as received, or null when the request
 *                  threw / was aborted without a response.
 *
 * A successful response with an EMPTY manifest is not a failure: the
 * timeline then shows its own honest "no scans yet" text.
 */
export function resolveProviderRead(
    response: { ok: boolean; body: unknown } | null
): ProviderReadResult {
    if (!response || response.ok !== true) {
        return { view: null, note: true };
    }

    const body = (response.body ?? {}) as Record<string, unknown>;

    if (body.success !== true) {
        return { view: null, note: true };
    }

    return { view: parseTrackingPayload(body.data), note: false };
}

export type TrackingProviderView = {
    entries: ShipmentTimelineEntry[];
    providerStatus: string | null;
    delivered: boolean;
    deliveredReceiver: string | null;
    deliveredAt: string | null;
};

/**
 * Read the `/api/orders/[id]/tracking` body defensively.
 *
 * A malformed or partial payload degrades to "no entries" instead of
 * throwing: the page must still be able to show the persisted status the
 * customer is actually entitled to.
 */
export function parseTrackingPayload(
    data: unknown
): TrackingProviderView {
    const payload = (data ?? {}) as Record<string, unknown>;

    const summary = (payload.summary ?? {}) as Record<
        string,
        unknown
    >;

    const deliveryStatus = (payload.deliveryStatus ??
        {}) as Record<string, unknown>;

    const manifestEntries = normalizeTrackingManifest(
        payload.manifest
    );

    const deliveryLabel =
        typeof deliveryStatus.status === "string"
            ? deliveryStatus.status.toUpperCase()
            : null;

    return {
        entries: manifestEntries,
        providerStatus:
            typeof summary.status === "string"
                ? summary.status
                : null,
        delivered:
            payload.delivered === true ||
            deliveryLabel === "DELIVERED",
        deliveredReceiver:
            typeof deliveryStatus.pod_receiver === "string"
                ? deliveryStatus.pod_receiver
                : null,
        deliveredAt:
            typeof deliveryStatus.pod_date === "string"
                ? [
                      deliveryStatus.pod_date,
                      typeof deliveryStatus.pod_time ===
                      "string"
                          ? deliveryStatus.pod_time
                          : "",
                  ]
                      .filter(Boolean)
                      .join(" ")
                      .trim()
                : null,
    };
}
