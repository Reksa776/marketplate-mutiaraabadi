/**
 * ==========================================
 * PUBLIC RESI LOOKUP — PURE LOGIC
 * ==========================================
 *
 * Everything the public "lacak resi" input on `/lacak` needs BEFORE it
 * renders, kept out of the route and the component so every rule can be
 * unit tested without a DOM, a network or a database:
 *
 *   * how a resi typed by a stranger is normalized and validated,
 *   * what the customer is told for an invalid, unknown or unreachable
 *     shipment,
 *   * how the REAL provider/local shipment state becomes one status
 *     label, a timeline and a "last updated" stamp.
 *
 * HARD RULES (mirrors lib/tracking/tracking-page.ts)
 *
 *   1. NOTHING is invented. Every value comes from the shipment provider
 *      response or from the synchronized `Order` columns. A failed
 *      provider read never becomes a status — it becomes a NOTE next to
 *      the last stored state.
 *   2. Exactly ONE uniform "not found" answer exists: it says nothing
 *      about whether a resi exists in somebody's account, so the lookup
 *      cannot be used to enumerate customers.
 *   3. The view carries SHIPMENT FACTS ONLY — no name, phone, e-mail,
 *      address, item, total, COD amount, order number, order id, guest
 *      token, payment reference or provider id can appear here, by
 *      construction: the type has no field for any of them.
 *
 * The module is pure (no prisma / no env / no network), so the route may
 * import it freely and the tests never touch a courier API.
 */

import { mapMengantarShipmentStatus } from "@/lib/mengantar/status";

import {
    normalizeTrackingManifest,
    type ShipmentTimelineEntry,
} from "./tracking-page";

/* ==========================================
 * INPUT LIMITS & MESSAGES
 * ========================================== */

/** Shortest resi shape any courier in this project issues. */
export const RESI_MIN_LENGTH = 6;

/** Upper bound; keeps a hostile long value out of a query and a view. */
export const RESI_MAX_LENGTH = 40;

/** Bound on the returned timeline so one resi cannot bloat a response. */
export const RESI_MAX_TIMELINE_ENTRIES = 40;

export const RESI_INVALID_MESSAGE =
    "Format nomor resi belum benar. Nomor resi berisi huruf dan angka, minimal 6 karakter.";

/**
 * ONE answer for "that resi does not exist" — used for an unknown resi
 * and for a resi that belongs to no shipment of ours alike, so the
 * response never confirms that a resi exists.
 */
export const RESI_NOT_FOUND_MESSAGE =
    "Nomor resi tidak ditemukan. Pastikan nomor resi sudah benar sesuai yang tertera pada informasi pesanan kamu.";

export const RESI_PROVIDER_UNAVAILABLE_MESSAGE =
    "Layanan pelacakan ekspedisi sedang terganggu. Berikut status terakhir yang tersimpan — silakan coba lagi beberapa saat lagi.";

export const RESI_STORED_ONLY_NOTE =
    "Riwayat perjalanan detail dari ekspedisi belum tersedia untuk pengiriman ini. Berikut status terakhir yang tersimpan.";

/**
 * The provider authoritatively says this shipment no longer exists
 * (Mengantar soft-delete). Stated as a fact, never as a status change.
 */
export const RESI_PROVIDER_GONE_NOTE =
    "Ekspedisi menyatakan data pengiriman ini sudah tidak tersedia. Berikut status terakhir yang tersimpan pada pesanan.";

export const RESI_THROTTLED_MESSAGE =
    "Terlalu banyak permintaan pelacakan. Silakan coba lagi dalam beberapa saat.";

export const RESI_SERVICE_ERROR_MESSAGE =
    "Layanan pelacakan sedang tidak dapat diakses. Silakan coba lagi beberapa saat lagi.";

/** Shown when the provider who owns this parcel sent no status at all. */
export const RESI_STATUS_UNKNOWN_LABEL = "Status belum tersedia";

/* ==========================================
 * NORMALIZATION / VALIDATION
 * ========================================== */

/**
 * Normalize a customer-typed resi, or null when it cannot be one.
 *
 * Conservative on purpose: trimmed, uppercased, inner whitespace
 * removed (couriers print resi with visual gaps), then restricted to the
 * characters a waybill may contain and to a bounded length — so a
 * hostile value can never reach a query, a log line or the view.
 */
export function normalizeResi(raw: unknown): string | null {
    if (typeof raw !== "string") {
        return null;
    }

    const value = raw
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");

    if (!value) {
        return null;
    }

    if (
        value.length < RESI_MIN_LENGTH ||
        value.length > RESI_MAX_LENGTH
    ) {
        return null;
    }

    /*
     * Must start with a letter/digit and may then contain digits,
     * letters and dashes — no url syntax, no quotes, no underscores.
     */
    if (!/^[A-Z0-9][A-Z0-9-]*$/.test(value)) {
        return null;
    }

    /* A value made only of dashes is not a resi. */
    if (!/[A-Z0-9]/.test(value)) {
        return null;
    }

    return value;
}

export function isValidResi(raw: unknown): boolean {
    return normalizeResi(raw) !== null;
}

/* ==========================================
 * STATUS MAPPING
 * ========================================== */

const RESI_STATUS_LABELS: Record<string, string> = {
    NOT_CREATED: "Pengiriman belum dibuat",
    SHIPMENT_PENDING: "Sedang disiapkan",
    CREATING: "Sedang disiapkan",
    WAITING_SHIPPING_PAYMENT: "Belum diserahkan ke ekspedisi",
    PAYING: "Belum diserahkan ke ekspedisi",
    SHIPPING_PAID: "Belum diserahkan ke ekspedisi",
    CREATED: "Paket dibuat, menunggu diambil kurir",
    PICKED_UP: "Paket sudah diambil kurir",
    IN_TRANSIT: "Paket dalam perjalanan",
    UNDELIVERED: "Paket gagal diantar",
    DELIVERED: "Paket sudah diterima",
    RETURNED: "Paket dikembalikan ke pengirim",
    CANCELLED: "Pengiriman dibatalkan",
    DELETED: "Data pengiriman dihapus",
};

/** Customer-facing label for an internal shipment status. */
export function resiStatusLabel(
    status: unknown
): string | null {
    const key = String(status ?? "")
        .trim()
        .toUpperCase();

    if (!key) {
        return null;
    }

    return RESI_STATUS_LABELS[key] ?? null;
}

export type ResiStatusView = {
    code: string | null;
    label: string;
};

/**
 * Resolve the status to display.
 *
 * Provider first (it owns the parcel and is the newest truth), then the
 * synchronized local column. An unknown provider category is IGNORED
 * rather than guessed (`mapMengantarShipmentStatus` returns null for the
 * informational categories), and the result is the stored state — never
 * a fabricated one.
 */
export function resolveResiStatus(input: {
    providerStatus?: string | null;
    storedStatus?: string | null;
}): ResiStatusView {
    const fromProvider =
        mapMengantarShipmentStatus(input.providerStatus) ??
        mapMengantarShipmentStatus(input.storedStatus);

    const providerLabel = fromProvider
        ? (RESI_STATUS_LABELS[fromProvider] ?? null)
        : null;

    if (fromProvider && providerLabel) {
        return { code: fromProvider, label: providerLabel };
    }

    /* An internal status outside the provider mapping (e.g. DELETED). */
    const storedKey = String(input.storedStatus ?? "")
        .trim()
        .toUpperCase();

    const storedLabel = RESI_STATUS_LABELS[storedKey];

    if (storedKey && storedLabel) {
        return { code: storedKey, label: storedLabel };
    }

    return { code: null, label: RESI_STATUS_UNKNOWN_LABEL };
}

/* ==========================================
 * VIEW
 * ========================================== */

/** The ONLY order fields this lookup may read. */
export type ResiOrderMeta = {
    shippingProvider: string | null;
    providerCourier: string | null;
    shippingCourier: string | null;
    shippingService: string | null;
    trackingNumber: string | null;
    shipmentStatus: string | null;
};

/** Provider read result, already narrowed by the caller. */
export type ResiProviderFetch = {
    status: string | null;
    statusCategory: string | null;
    trackingNumber: string | null;
    history: { date?: string | null; desc?: string | null }[] | null;
} | null;

export type ResiTrackingView = {
    waybill: string;
    courier: string | null;
    service: string | null;
    status: ResiStatusView;
    delivered: boolean;
    timeline: ShipmentTimelineEntry[];
    lastUpdate: string | null;
    notes: string[];
    source: "PROVIDER" | "STORED";
};

/**
 * Build the ONE view the page renders.
 *
 * @param input.waybill       the normalized resi that was searched for.
 * @param input.order         shipment facts of the matching order.
 * @param input.fetched       provider read, or null when it was not
 *                            attempted / did not succeed.
 * @param input.providerFailed the provider read was ATTEMPTED and failed.
 * @param input.localOnly     the order is served by a provider whose
 *                            detail lookup this project does not
 *                            integrate (legacy RajaOngkir), so only the
 *                            synchronized state is shown.
 * @param input.providerGone  the provider itself reports the shipment as
 *                            removed — a fact to disclose, not a status.
 */
export function buildResiTrackingView(input: {
    waybill: string;
    order: ResiOrderMeta;
    fetched: ResiProviderFetch;
    providerFailed?: boolean;
    localOnly?: boolean;
    providerGone?: boolean;
}): ResiTrackingView {
    const { order, fetched } = input;

    const byProviderCategory =
        mapMengantarShipmentStatus(fetched?.statusCategory) ?? null;

    const byProviderStatus =
        mapMengantarShipmentStatus(fetched?.status) ?? null;

    const status = resolveResiStatus({
        providerStatus:
            byProviderCategory ??
            byProviderStatus ??
            fetched?.status ??
            null,
        storedStatus: order.shipmentStatus,
    });

    const timeline = normalizeTrackingManifest(
        (fetched?.history ?? []).map((entry) => ({
            manifest_date: entry?.date ?? "",
            manifest_description: entry?.desc ?? "",
        }))
    ).slice(0, RESI_MAX_TIMELINE_ENTRIES);

    const notes: string[] = [];

    if (input.providerGone) {
        notes.push(RESI_PROVIDER_GONE_NOTE);
    } else if (input.providerFailed) {
        notes.push(RESI_PROVIDER_UNAVAILABLE_MESSAGE);
    } else if (input.localOnly) {
        notes.push(RESI_STORED_ONLY_NOTE);
    }

    return {
        waybill:
            fetched?.trackingNumber?.trim() ||
            input.waybill,
        courier:
            order.providerCourier ??
            order.shippingCourier ??
            null,
        service: order.shippingService ?? null,
        status,
        delivered: status.code === "DELIVERED",
        timeline,
        /*
         * The newest scan the provider reported, if it reported one. A
         * stored-only view has no timestamp to offer and says nothing
         * rather than inventing one.
         */
        lastUpdate: timeline[0]?.date || null,
        notes,
        source: fetched ? "PROVIDER" : "STORED",
    };
}
