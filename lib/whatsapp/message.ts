/**
 * ==========================================
 * WHATSAPP MESSAGE TEMPLATES
 * ==========================================
 *
 * Simple transactional message templates
 * for order status notifications.
 *
 * Phase 2: Basic templates only.
 * No marketing, no templates system.
 */

import type { SendNotificationPayload } from "@/lib/notification/types";

/**
 * ==========================================
 * STATUS LABELS (Bahasa Indonesia)
 * ==========================================
 */

const STATUS_LABELS: Record<string, string> = {
    PENDING: "Menunggu Pembayaran",
    PAID: "Pembayaran Diterima",
    PROCESSING: "Sedang Diproses",
    SHIPPED: "Dikirim",
    COMPLETED: "Selesai",
    CANCELLED: "Dibatalkan",

    // Mengantar shipment (fulfilment) events. Kept in the same
    // template map so the existing notification pipeline renders
    // consistent Bahasa Indonesia wording.
    SHIPPING_PAYMENT_REQUIRED:
        "Menunggu Pembayaran Ongkir",
    SHIPMENT_CREATED: "Paket Sedang Disiapkan",
    SHIPMENT_PICKED_UP: "Paket Sudah Diambil Kurir",
    SHIPMENT_IN_TRANSIT: "Paket Dalam Perjalanan",
    SHIPMENT_DELIVERED: "Paket Sudah Diterima",
    SHIPMENT_UNDELIVERED: "Paket Gagal Diantar",
    SHIPMENT_RETURNED: "Paket Dikembalikan (RTS)",
    SHIPMENT_CANCELLED: "Pengiriman Dibatalkan",
};

/**
 * ==========================================
 * FORMAT CURRENCY (Rupiah)
 * ==========================================
 */

function formatRupiah(amount: number): string {
    return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(amount);
}

/**
 * ==========================================
 * FORMAT ITEMS LIST
 * ==========================================
 */

function formatItems(
    items: SendNotificationPayload["items"]
): string {
    if (!items || items.length === 0) {
        return "";
    }

    return items
        .map(
            (item, index) =>
                `${index + 1}. ${item.productName} (${item.variantName}) x${item.quantity}`
        )
        .join("\n");
}

/**
 * ==========================================
 * GENERATE ORDER STATUS MESSAGE
 * ==========================================
 *
 * Creates a simple transactional message
 * for order status changes.
 *
 * Does NOT expose internal database IDs.
 * Includes tracking URL if available.
 */
export function generateOrderStatusMessage(
    payload: SendNotificationPayload
): string {
    const statusLabel =
        STATUS_LABELS[payload.newStatus] ||
        payload.newStatus;

    const lines: string[] = [];

    // Header
    lines.push(
        `Halo ${payload.recipient},`
    );
    lines.push("");
    lines.push(
        `Pesanan Anda *${payload.orderNumber}* telah diperbarui.`
    );
    lines.push(
        `Status: *${statusLabel}*`
    );

    // Items summary
    const itemsText = formatItems(payload.items);
    if (itemsText) {
        lines.push("");
        lines.push("Detail:");
        lines.push(itemsText);
    }

    // Total
    lines.push("");
    lines.push(
        `Total: *${formatRupiah(payload.total)}*`
    );

    // Tracking info
    if (
        payload.trackingNumber &&
        payload.trackingUrl
    ) {
        lines.push("");
        lines.push(
            `No. Resi: ${payload.trackingNumber}`
        );
        lines.push(
            `Kurir: ${payload.shippingCourier || "-"}`
        );
        lines.push("");
        lines.push(
            `Lacak pengiriman: ${payload.trackingUrl}`
        );
    } else if (payload.trackingNumber) {
        lines.push("");
        lines.push(
            `No. Resi: ${payload.trackingNumber}`
        );
        lines.push(
            `Kurir: ${payload.shippingCourier || "-"}`
        );
    }

    // Footer
    lines.push("");
    lines.push(
        "Terima kasih telah berbelanja di toko kami."
    );

    return lines.join("\n");
}

/**
 * ==========================================
 * GENERATE TEST MESSAGE
 * ==========================================
 *
 * Simple test message for admin verification.
 */
export function generateTestMessage(): string {
    const timestamp = new Date().toLocaleString(
        "id-ID",
        {
            timeZone: "Asia/Jakarta",
        }
    );

    return [
        "✅ *Test Message - WhatsApp Terhubung*",
        "",
        `Waktu: ${timestamp}`,
        "",
        "Pesan ini dikirim dari admin panel untuk memverifikasi koneksi WhatsApp.",
    ].join("\n");
}
