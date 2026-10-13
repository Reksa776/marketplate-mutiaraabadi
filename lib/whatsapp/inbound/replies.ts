/**
 * ==========================================================
 * WHATSAPP AUTO-REPLY — ORDER & TRACKING REPLIES (PURE)
 * ==========================================================
 *
 * Maps the REAL order/shipment state onto a customer-facing message.
 *
 * HARD RULES
 *
 *   1. Every value printed here comes from the database or from the
 *      shipment provider. Nothing is estimated, invented or inferred —
 *      no fake resi, no fake location, no delivery ETA.
 *   2. The order/payment/shipment axes stay DISTINCT. "Pembayaran
 *      diterima" is never phrased as "paket dikirim" (§ requirement).
 *   3. A package is only ever described as received when the courier's
 *      own status says DELIVERED — otherwise the wording stays at
 *      "ditandai terkirim oleh ekspedisi".
 *   4. No address, no phone number, no email, no item list, no total,
 *      no payment reference, no token and no internal id.
 *   5. A provider read that failed is DISCLOSED, not hidden: the last
 *      stored state is shown with a note that the newest update is not
 *      available right now (§ requirement "Tracking API gagal").
 *
 * The module is pure so every branch (new order, in transit, delivered,
 * completed, cancelled, provider down) is unit testable without a
 * WhatsApp session or a live courier API.
 */

import type { TrackingView } from "./tracking";
import { postDeliveryMenu } from "./menu";

/**
 * The order fields the bot is allowed to read. Deliberately narrow: no
 * `address`, `phone`, `customerEmail`, `userId`, token hash or payment
 * field can even be passed to a formatter.
 */
export type BotOrder = {
    id: number;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    createdAt: Date;
    shippingProvider: string | null;
    providerCourier: string | null;
    shippingCourier: string | null;
    shippingService: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    shipmentStatus: string | null;
    shippingPaymentStatus: string | null;
};

const ORDER_STATUS_LABELS: Record<string, string> = {
    PENDING: "Menunggu Pembayaran",
    PAID: "Sudah Dibayar",
    PROCESSING: "Sedang Diproses",
    SHIPPED: "Sedang Dikirim",
    COMPLETED: "Selesai",
    CANCELLED: "Dibatalkan",
    REFUND_PENDING: "Refund Sedang Diproses",
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
    UNPAID: "Belum Dibayar",
    PENDING: "Menunggu Konfirmasi Pembayaran",
    PAID: "Pembayaran Diterima",
    FAILED: "Pembayaran Gagal",
    EXPIRED: "Pembayaran Kedaluwarsa",
    REFUNDED: "Sudah Direfund",
};

const SHIPMENT_STATUS_LABELS: Record<string, string> = {
    NOT_CREATED: "Pengiriman Belum Dibuat",
    SHIPMENT_PENDING: "Pesanan Sedang Disiapkan",
    CREATING: "Pesanan Sedang Disiapkan",
    WAITING_SHIPPING_PAYMENT: "Paket Belum Diserahkan ke Ekspedisi",
    PAYING: "Paket Belum Diserahkan ke Ekspedisi",
    SHIPPING_PAID: "Paket Belum Diserahkan ke Ekspedisi",
    CREATED: "Paket Dibuat, Belum Diambil Kurir",
    PICKED_UP: "Paket Sudah Diambil Kurir",
    IN_TRANSIT: "Paket Dalam Perjalanan",
    UNDELIVERED: "Paket Gagal Diantar",
    DELIVERED: "Terkirim",
    RETURNED: "Paket Dikembalikan ke Pengirim",
    CANCELLED: "Pengiriman Dibatalkan",
    DELETED: "Data Pengiriman Dihapus Admin",
};

/** Shipment statuses after which no further movement is expected. */
const TERMINAL_SHIPMENT_STATUSES = new Set([
    "DELIVERED",
    "RETURNED",
    "CANCELLED",
    "DELETED",
]);

export function orderStatusLabel(status: unknown): string {
    const key = String(status ?? "").toUpperCase();
    return (
        ORDER_STATUS_LABELS[key] ??
        // Unknown/new statuses are shown verbatim rather than blank.
        (key || "Tidak Diketahui")
    );
}

export function paymentStatusLabel(status: unknown): string {
    const key = String(status ?? "").toUpperCase();
    return (
        PAYMENT_STATUS_LABELS[key] ??
        (key || "Tidak Diketahui")
    );
}

export function shipmentStatusLabel(status: unknown): string {
    if (status === null || status === undefined || status === "") {
        return "Belum Ada Informasi Pengiriman";
    }

    const key = String(status).toUpperCase();

    return (
        SHIPMENT_STATUS_LABELS[key] ??
        "Status Pengiriman Diperbarui"
    );
}

/**
 * True when nothing further will move on this order: a delivered,
 * returned, cancelled or admin-deleted shipment, or a finished/void
 * order. The caller uses this to SKIP unnecessary provider calls.
 */
export function isTerminalOrderState(order: {
    status: string;
    shipmentStatus: string | null;
}): boolean {
    const orderStatus = String(order.status ?? "").toUpperCase();

    if (
        orderStatus === "COMPLETED" ||
        orderStatus === "CANCELLED"
    ) {
        return true;
    }

    return TERMINAL_SHIPMENT_STATUSES.has(
        String(order.shipmentStatus ?? "").toUpperCase()
    );
}

/** True when the courier marked the parcel delivered. */
export function isDelivered(
    order: BotOrder
): boolean {
    return (
        String(order.shipmentStatus ?? "").toUpperCase() ===
        "DELIVERED"
    );
}

/** Courier name as stored, preferring the provider's own value. */
export function courierName(
    order: BotOrder,
    view: TrackingView | null
): string | null {
    return (
        view?.courier ??
        order.providerCourier ??
        order.shippingCourier ??
        null
    );
}

/** Resi, preferring the value the provider just returned. */
export function trackingNumberFor(
    order: BotOrder,
    view: TrackingView | null
): string | null {
    return view?.trackingNumber ?? order.trackingNumber ?? null;
}

function formatOrderDate(date: Date): string {
    try {
        return new Intl.DateTimeFormat("id-ID", {
            timeZone: "Asia/Jakarta",
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        }).format(date);
    } catch {
        return date.toISOString();
    }
}

/**
 * The four lines every tracking answer must contain (§ requirement:
 * order number, courier, resi, latest status).
 */
function identityLines(
    order: BotOrder,
    view: TrackingView | null
): string[] {
    const resi = trackingNumberFor(order, view);
    const courier = courierName(order, view);

    return [
        `Nomor Pesanan: ${order.orderNumber}`,
        `Ekspedisi: ${courier ?? "Belum ditentukan"}`,
        `Nomor Resi: ${resi ?? "Belum tersedia"}`,
    ];
}

/**
 * Provider-failure disclosure + the newest history entries we do have.
 * Never claims the state is current when the provider read failed.
 */
function historySection(
    view: TrackingView | null
): string[] {
    const lines: string[] = [];

    if (view?.note) {
        lines.push("", `ℹ️ ${view.note}`);
    }

    const entries = (view?.history ?? []).slice(-5).reverse();

    if (entries.length > 0) {
        lines.push("", "Riwayat terbaru:");

        for (const entry of entries) {
            const when = entry.date ? `${entry.date} — ` : "";
            lines.push(`• ${when}${entry.description}`);
        }
    }

    return lines;
}

/**
 * ==========================================================
 * LACAK RESI
 * ==========================================================
 *
 * Branches on the CURRENT state, re-read from the database on every
 * request — a message sent before the parcel moved therefore returns
 * today's truth, never the status of the day it was written.
 */
export function buildTrackingReply(
    order: BotOrder,
    view: TrackingView | null
): string {
    const shipment = String(
        order.shipmentStatus ?? ""
    ).toUpperCase();
    const resi = trackingNumberFor(order, view);

    const lines = identityLines(order, view);

    /* ---- Cancelled: no active shipment, and never resurrected ---- */
    if (
        order.status === "CANCELLED" ||
        shipment === "CANCELLED"
    ) {
        return [
            "📦 INFORMASI PENGIRIMAN",
            "",
            ...lines,
            "Status: Pesanan Dibatalkan",
            "",
            "Pesanan ini sudah dibatalkan dan tidak memiliki pengiriman aktif.",
            "",
            "Ketik 0 untuk kembali ke Menu Utama.",
        ].join("\n");
    }

    /* ---- Admin deleted the shipment record ---- */
    if (shipment === "DELETED") {
        return [
            "📦 INFORMASI PENGIRIMAN",
            "",
            ...lines,
            "Status: Data pengiriman dihapus admin",
            "",
            "Data pengiriman pesanan ini tidak lagi tersedia. Silakan",
            "hubungi admin kami (ketik 3) untuk pengecekan lebih lanjut.",
        ].join("\n");
    }

    /* ---- Returned to sender ---- */
    if (shipment === "RETURNED") {
        return [
            "📦 INFORMASI PENGIRIMAN",
            "",
            ...lines,
            "Status: Paket Dikembalikan ke Pengirim",
            "",
            "Ekspedisi menandai paket ini dikembalikan ke pengirim.",
            "Silakan hubungi admin kami (ketik 3) untuk tindak lanjut.",
            ...historySection(view),
        ].join("\n");
    }

    /* ---- Delivery attempt failed ---- */
    if (shipment === "UNDELIVERED") {
        return [
            "📦 INFORMASI PENGIRIMAN",
            "",
            ...lines,
            "Status: Paket Gagal Diantar",
            "",
            "Ekspedisi menandai paket ini gagal diantar.",
            "Silakan hubungi admin kami (ketik 3) agar dibantu penjadwalan ulang.",
            ...historySection(view),
        ].join("\n");
    }

    /* ---- Delivered: the parcel IS received per the courier ---- */
    if (shipment === "DELIVERED") {
        return [
            "📦 PAKET TELAH DITERIMA",
            "",
            ...lines,
            "Status: Terkirim",
            "",
            "Terima kasih sudah berbelanja di Mutiara Abadi! 🎉",
            ...historySection(view),
            "",
            postDeliveryMenu(),
        ].join("\n");
    }

    /* ---- Order completed (final state, tracking stays reachable) ---- */
    if (order.status === "COMPLETED") {
        return [
            "📦 PESANAN SELESAI",
            "",
            ...lines,
            "Status: Selesai",
            "",
            "Terima kasih sudah berbelanja di Mutiara Abadi! 🎉",
            ...historySection(view),
            "",
            postDeliveryMenu(),
        ].join("\n");
    }

    /* ---- No resi yet: say WHY, per the real state ---- */
    if (!resi) {
        let reason: string;

        if (
            order.status === "PENDING" &&
            order.paymentStatus !== "PAID"
        ) {
            reason =
                "Pesanan kamu belum dibayar, sehingga resi belum tersedia.";
        } else if (
            shipment === "WAITING_SHIPPING_PAYMENT" ||
            shipment === "PAYING"
        ) {
            reason =
                "Paket belum diserahkan ke ekspedisi, sehingga resi belum tersedia.";
        } else if (
            order.status === "PAID" ||
            shipment === "NOT_CREATED" ||
            shipment === "SHIPMENT_PENDING" ||
            shipment === "CREATING" ||
            !shipment
        ) {
            reason =
                "Pesanan kamu sedang disiapkan, resi belum tersedia.";
        } else {
            reason =
                "Resi belum tersedia untuk pesanan ini.";
        }

        return [
            "📦 INFORMASI PENGIRIMAN",
            "",
            ...lines,
            "Status: Resi belum tersedia",
            "",
            reason,
            "",
            "Ketik 2 untuk melihat status pesanan, atau 0 untuk Menu Utama.",
        ].join("\n");
    }

    /* ---- In flight (picked up / in transit / created) ---- */
    const statusLine =
        shipment === "CREATED" || shipment === "SHIPPING_PAID"
            ? "Paket Dibuat, Belum Diambil Kurir"
            : shipmentStatusLabel(order.shipmentStatus);

    return [
        "📦 STATUS PENGIRIMAN",
        "",
        ...lines,
        `Status: ${statusLine}`,
        ...historySection(view),
        "",
        "Ketik 2 untuk melihat status pesanan, atau 0 untuk Menu Utama.",
    ].join("\n");
}

/**
 * ==========================================================
 * STATUS PESANAN
 * ==========================================================
 *
 * Three independent axes, always labelled separately so a successful
 * payment can never be read as "shipped".
 */
export function buildStatusReply(order: BotOrder): string {
    const resi = order.trackingNumber;
    const courier =
        order.providerCourier ?? order.shippingCourier ?? null;

    const lines = [
        "📋 STATUS PESANAN",
        "",
        `Nomor Pesanan: ${order.orderNumber}`,
        `Tanggal Pesanan: ${formatOrderDate(order.createdAt)}`,
        "",
        `Status Pesanan: ${orderStatusLabel(order.status)}`,
        `Status Pembayaran: ${paymentStatusLabel(order.paymentStatus)}`,
        `Status Pengiriman: ${shipmentStatusLabel(order.shipmentStatus)}`,
    ];

    if (resi || courier) {
        lines.push(
            "",
            `Ekspedisi: ${courier ?? "Belum ditentukan"}`,
            `Nomor Resi: ${resi ?? "Belum tersedia"}`
        );
    }

    lines.push(
        "",
        "Ketik 1 untuk melacak resi, atau 0 untuk Menu Utama."
    );

    return lines.join("\n");
}

/**
 * "1. Lihat Riwayat Pengiriman" — only called AFTER the customer asks
 * for it, so a finished shipment does not cost a provider call on every
 * unrelated message.
 */
export function buildHistoryReply(
    order: BotOrder,
    view: TrackingView | null
): string {
    const entries = view?.history ?? [];

    const lines = [
        "🚚 RIWAYAT PENGIRIMAN",
        "",
        ...identityLines(order, view),
        `Status: ${isDelivered(order) ? "Terkirim" : shipmentStatusLabel(order.shipmentStatus)}`,
    ];

    if (view?.note) {
        lines.push("", `ℹ️ ${view.note}`);
    }

    if (entries.length === 0) {
        lines.push(
            "",
            view?.providerRead
                ? "Riwayat perjalanan paket belum tersedia dari ekspedisi."
                : "Riwayat pengiriman tidak tersedia untuk pesanan ini."
        );
    } else {
        lines.push("", "Riwayat:");

        for (const entry of entries) {
            const when = entry.date ? `${entry.date} — ` : "";
            lines.push(`• ${when}${entry.description}`);
        }
    }

    lines.push("", postDeliveryMenu());

    return lines.join("\n");
}
