/**
 * ==========================================
 * WHATSAPP ORDER CONFIRMATION LINK
 * ==========================================
 *
 * Builds the `wa.me` link a CUSTOMER taps after checkout to open a chat
 * with the store's admin number.
 *
 * DESIGN RULES
 *
 *   1. The link is a HAND-OFF, not a send. We only pre-fill a draft
 *      message; the customer presses Send inside their own WhatsApp.
 *      The server never sends anything to, or on behalf of, the
 *      customer for this feature.
 *
 *   2. The destination number never comes from customer input. It is
 *      the number of the WhatsApp account really connected by QR in the
 *      admin dashboard (see ./admin-number.ts) — never a query
 *      parameter, never a second "admin number" setting that could
 *      drift, and never the customer's own number.
 *
 *   3. The message carries ONLY the order number, the customer name and
 *      the current order status. A wa.me URL lands in browser history,
 *      is shareable, and is read by the receiving app, so anything put
 *      in it must be treated as public: no guest access token, no OTP,
 *      no cookie value, no payment reference, no address/phone.
 *
 *   4. A destination that is not already a normalized international
 *      number yields NO link (null) instead of a guessed one — a wrong
 *      number would silently open a chat with a stranger.
 *
 * This module is intentionally pure: no server-only imports, so it can
 * be unit tested without starting a WhatsApp/Baileys session.
 */

/**
 * Customer-facing labels for `Order_status`. Mirrors the wording used by
 * the order pages so the draft and the UI never disagree.
 */
const ORDER_STATUS_LABELS: Record<string, string> = {
    PENDING: "Menunggu Pembayaran",
    PAID: "Sudah Dibayar",
    PROCESSING: "Sedang Diproses",
    SHIPPED: "Sedang Dikirim",
    COMPLETED: "Selesai",
    CANCELLED: "Dibatalkan",
    REFUND_PENDING: "Refund Diproses",
};

/** Max lengths keep a hostile/long value from bloating the URL. */
export const WHATSAPP_CONFIRM_MAX_ORDER_NUMBER = 40;
export const WHATSAPP_CONFIRM_MAX_NAME = 60;
export const WHATSAPP_CONFIRM_MAX_STATUS = 60;

/** Same bare-domain form the rest of the app links to. */
export const WHATSAPP_ME_BASE_URL = "https://wa.me";

/**
 * Human label for an `Order_status` value. Unknown statuses fall through
 * verbatim rather than becoming an empty string.
 */
export function getOrderConfirmStatusLabel(
    status: string
): string {
    return ORDER_STATUS_LABELS[status] ?? status;
}

/**
 * Flatten a value before it is interpolated into the draft message.
 *
 * A newline inside a name is not cosmetic: it would let a crafted value
 * inject extra lines ("Status Pesanan: Sudah Dibayar") into the message
 * the ADMIN reads. Control characters are therefore replaced with a
 * space, runs of whitespace collapsed, and the result truncated.
 */
export function sanitizeConfirmField(
    value: unknown,
    maxLength: number
): string {
    if (typeof value !== "string") {
        return "";
    }

    const flattened = value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (flattened.length <= maxLength) {
        return flattened;
    }

    return flattened.slice(0, maxLength).trim();
}

/**
 * The draft the customer sends. Deliberately plain text: no markdown
 * markers to escape, and nothing that is not already visible to the
 * customer on the page they are reading.
 */
export function buildOrderConfirmMessage(input: {
    orderNumber: string;
    customerName?: string | null;
    statusLabel: string;
}): string {
    const orderNumber = sanitizeConfirmField(
        input.orderNumber,
        WHATSAPP_CONFIRM_MAX_ORDER_NUMBER
    );

    const customerName = sanitizeConfirmField(
        input.customerName ?? "",
        WHATSAPP_CONFIRM_MAX_NAME
    );

    const statusLabel = sanitizeConfirmField(
        input.statusLabel,
        WHATSAPP_CONFIRM_MAX_STATUS
    );

    return [
        "Halo Admin, saya ingin konfirmasi pesanan saya.",
        "",
        `Nomor Pesanan: ${orderNumber || "-"}`,
        `Nama: ${customerName || "-"}`,
        `Status Pesanan: ${statusLabel || "-"}`,
        "",
        "Mohon dibantu untuk konfirmasinya. Terima kasih.",
    ].join("\n");
}

/**
 * The draft a customer sends when they need HELP WITH A PROBLEM, from
 * the tracking page (see app/lacak).
 *
 * Deliberately minimal: only the order number, which the customer is
 * already looking at on that page (and which the chat flow already
 * carries).
 *
 * No name, status, address, phone, email, token or payment reference is
 * added: a `wa.me` url is readable by the receiving app, lands in browser
 * history and can be forwarded, so it is treated as public and carries
 * nothing that would be new exposure.
 */
export function buildOrderProblemMessage(input: {
    orderNumber: string;
}): string {
    const orderNumber = sanitizeConfirmField(
        input.orderNumber,
        WHATSAPP_CONFIRM_MAX_ORDER_NUMBER
    );

    return [
        "Halo Admin, saya butuh bantuan untuk pesanan saya.",
        "",
        `Nomor Pesanan: ${orderNumber || "-"}`,
        "",
        "Mohon dibantu pengecekannya. Terima kasih.",
    ].join("\n");
}

/**
 * Problem-report variant of the hand-off link. Same destination rules as
 * the confirmation link: the number must already be a normalized
 * international number or the caller gets null instead of a link.
 */
export function buildWhatsAppProblemUrl(input: {
    adminPhoneNumber: string | null | undefined;
    orderNumber: string;
}): string | null {
    const phoneNumber = (
        input.adminPhoneNumber ?? ""
    ).trim();

    if (!isWaMeCompatibleNumber(phoneNumber)) {
        return null;
    }

    const message = buildOrderProblemMessage({
        orderNumber: input.orderNumber,
    });

    return `${WHATSAPP_ME_BASE_URL}/${phoneNumber}?text=${encodeURIComponent(
        message
    )}`;
}

/**
 * `wa.me` accepts only the international form WITHOUT "+", spaces or
 * dashes ("6281234567890") — exactly what `normalizePhone()` produces.
 * Anything else is refused: this is the last gate before a link is
 * handed to a customer.
 */
export function isWaMeCompatibleNumber(
    phoneNumber: string
): boolean {
    return /^62\d{8,13}$/.test(phoneNumber);
}

/**
 * Build the confirmation link, or null when there is no trustworthy
 * destination. Returning null is a feature: the caller must then tell
 * the customer that admin WhatsApp is unavailable rather than rendering
 * a link that goes nowhere.
 */
export function buildWhatsAppConfirmUrl(input: {
    adminPhoneNumber: string | null | undefined;
    orderNumber: string;
    customerName?: string | null;
    statusLabel: string;
}): string | null {
    const phoneNumber = (
        input.adminPhoneNumber ?? ""
    ).trim();

    if (!isWaMeCompatibleNumber(phoneNumber)) {
        return null;
    }

    const message = buildOrderConfirmMessage({
        orderNumber: input.orderNumber,
        customerName: input.customerName,
        statusLabel: input.statusLabel,
    });

    return `${WHATSAPP_ME_BASE_URL}/${phoneNumber}?text=${encodeURIComponent(
        message
    )}`;
}
