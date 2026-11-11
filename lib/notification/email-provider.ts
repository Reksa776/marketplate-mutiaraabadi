/**
 * ==========================================
 * EMAIL NOTIFICATION PROVIDER
 * ==========================================
 *
 * Delivers notifications over the existing VPS mailbox through the
 * shared SMTP mailer (see lib/mailer.ts).
 *
 * Used by the guest order recovery OTP as an ALTERNATIVE to WhatsApp:
 * the same challenge, the same code hashing/expiry/attempt rules and
 * the same fail-closed contract — only the transport differs.
 *
 * RECIPIENT
 * ---------
 * The address is supplied by the caller, and lib/guest-recovery.ts
 * always derives it from the ORDER's stored `customerEmail` — never
 * from a value typed into the recovery form. Because a misspelled or
 * attacker-chosen address would hand the code to the wrong mailbox,
 * a recipient that does not look like an email address is refused
 * here as well (defence in depth, and it fails CLOSED).
 *
 * SECRETS
 * -------
 * A raw message can carry a one-time code, so it is only ever handed
 * to the mailer: never logged, never persisted and never returned.
 */

import {
    isMailerConfigured,
    sendMail,
} from "@/lib/mailer";

import {
    isRawMessagePayload,
    type NotificationPayload,
    type SendNotificationPayload,
    type SendNotificationResult,
} from "./types";
import type { NotificationProvider } from "./provider";

/** Same shape the checkout form accepts for a guest email. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RECOVERY_SUBJECT =
    "Mutiara Abadi Snack | Kode Verifikasi Akses Pesanan";

const STATUS_LABELS: Record<string, string> = {
    PENDING: "Menunggu pembayaran",
    PAID: "Pembayaran diterima",
    PROCESSING: "Sedang diproses",
    SHIPPED: "Dalam pengiriman",
    COMPLETED: "Pesanan selesai",
    CANCELLED: "Pesanan dibatalkan",
    SHIPPING_PAYMENT_REQUIRED: "Menunggu pembayaran ongkir",
    SHIPMENT_CREATED: "Paket sedang disiapkan",
    SHIPMENT_PICKED_UP: "Paket telah dijemput kurir",
    SHIPMENT_IN_TRANSIT: "Paket dalam perjalanan",
    SHIPMENT_DELIVERED: "Paket telah diterima",
    SHIPMENT_UNDELIVERED: "Paket belum berhasil diantar",
    SHIPMENT_RETURNED: "Paket dikembalikan",
    SHIPMENT_CANCELLED: "Pengiriman dibatalkan",
};

export class EmailNotificationProvider
    implements NotificationProvider
{
    readonly name = "email";

    /**
     * Configured = the mailbox is provisioned. Without
     * SMTP_HOST/SMTP_USER/SMTP_PASSWORD every send fails closed, so an
     * un-provisioned server can never look like a successful delivery.
     */
    isConfigured(): boolean {
        return isMailerConfigured();
    }

    async send(
        payload: NotificationPayload
    ): Promise<SendNotificationResult> {
        const to = payload.recipient.trim();

        if (
            !to ||
            to.length > 191 ||
            !EMAIL_PATTERN.test(to)
        ) {
            /*
             * Fail closed rather than let the mail server decide: a
             * malformed recipient must never be a silent success.
             */
            return {
                success: false,
                errorCode: "INVALID_RECIPIENT",
                errorMessage:
                    "Alamat email penerima tidak valid.",
            };
        }

        /*
         * A raw message (the OTP) is used verbatim as the body. The
         * order-status branch exists so this provider can serve the
         * existing notification pipeline too.
         */
        const text = isRawMessagePayload(payload)
            ? payload.rawMessage
            : buildStatusMessage(payload);

        const isCodCreation = !isRawMessagePayload(payload) &&
            payload.previousStatus === "CREATED" &&
            payload.newStatus === "PENDING" &&
            payload.paymentMethod === "COD";
        const subject = isRawMessagePayload(payload)
            ? RECOVERY_SUBJECT
            : isCodCreation
              ? `Mutiara Abadi Snack | Pesanan COD Baru ${payload.orderNumber}`
              : `Mutiara Abadi Snack | ${payload.orderNumber} — ${STATUS_LABELS[payload.newStatus] || payload.newStatus}`;

        const result = await sendMail({
            to,
            subject,
            text,
            html: isRawMessagePayload(payload)
                ? textToHtml(text)
                : buildStatusHtml(payload),
        });

        if (!result.success) {
            return {
                success: false,
                errorCode: result.errorCode,
                errorMessage: result.errorMessage,
            };
        }

        console.log(
            `[EMAIL] Notification sent | Order: ${payload.orderNumber} | Type: ${payload.notificationType} | Recipient: ${maskEmail(to)}`
        );

        return {
            success: true,
            providerMessageId:
                result.messageId ?? undefined,
        };
    }
}

/**
 * Order-status fallback body (no OTP involved).
 */
function buildStatusMessage(
    payload: NotificationPayload
): string {
    if (isRawMessagePayload(payload)) {
        return payload.rawMessage;
    }

    const isCodCreation =
        payload.previousStatus === "CREATED" &&
        payload.newStatus === "PENDING" &&
        payload.paymentMethod === "COD";

    const lines = [
        "MUTIARA ABADI SNACK",
        "Notifikasi pesanan dari website Mutiara Abadi Snack.",
        "",
        "Halo,",
        "",
        isCodCreation
            ? `Pesanan COD ${payload.orderNumber} berhasil dicatat.`
            : `Ada pembaruan untuk pesanan ${payload.orderNumber}.`,
        `Status pesanan: ${STATUS_LABELS[payload.newStatus] || payload.newStatus}`,
        "",
        "RINCIAN PESANAN",
        ...(payload.items.length
            ? payload.items.map((item, index) =>
                  `${index + 1}. ${item.productName}${item.variantName ? ` — ${item.variantName}` : ""} × ${item.quantity}`
              )
            : ["Rincian produk tidak tersedia."]),
        "",
        `Total pesanan: ${formatRupiah(payload.total)}`,
    ];

    if (payload.trackingNumber) {
        lines.push(`Nomor resi: ${payload.trackingNumber}`);
        lines.push(`Kurir: ${payload.shippingCourier || "-"}`);
    }
    if (payload.trackingUrl) lines.push(`Lacak pesanan: ${payload.trackingUrl}`);

    lines.push("", "Terima kasih telah mempercayakan pesanan Anda kepada Mutiara Abadi Snack.");
    lines.push("Pesan ini dikirim otomatis oleh website Mutiara Abadi Snack.");
    return lines.join("\n");
}

function formatRupiah(amount: number): string {
    return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(amount);
}

function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function safeHttpUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:"
            ? url.toString()
            : null;
    } catch {
        return null;
    }
}

/** Branded HTML wrapper for raw security messages such as recovery codes. */
function textToHtml(text: string): string {
    const escaped = escapeHtml(text).replace(/\n/g, "<br>");
    return `<div style="margin:0;background:#f7f4ef;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;color:#292524"><div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;overflow:hidden"><div style="background:#78350f;padding:22px 28px;color:#ffffff"><div style="font-size:20px;font-weight:700;letter-spacing:.3px">Mutiara Abadi Snack</div><div style="font-size:12px;margin-top:5px;color:#fef3c7">Website resmi · Notifikasi otomatis</div></div><div style="padding:28px;font-size:14px;line-height:1.7">${escaped}</div><div style="padding:16px 28px;background:#fafaf9;border-top:1px solid #e7e5e4;color:#78716c;font-size:11px">Email ini dikirim otomatis oleh website Mutiara Abadi Snack.</div></div></div>`;
}

function buildStatusHtml(
    payload: SendNotificationPayload
): string {
    const status = STATUS_LABELS[payload.newStatus] || payload.newStatus;
    const codCreated = payload.previousStatus === "CREATED" &&
        payload.newStatus === "PENDING" &&
        "paymentMethod" in payload && payload.paymentMethod === "COD";
    const trackingUrl = safeHttpUrl(payload.trackingUrl);
    const rows = payload.items.map((item) =>
        `<tr><td style="padding:12px 8px;border-bottom:1px solid #eee7df;color:#292524">${escapeHtml(item.productName)}${item.variantName ? `<div style="font-size:12px;color:#78716c;margin-top:3px">${escapeHtml(item.variantName)}</div>` : ""}</td><td style="padding:12px 8px;border-bottom:1px solid #eee7df;text-align:center;color:#292524">${escapeHtml(item.quantity)}</td><td style="padding:12px 8px;border-bottom:1px solid #eee7df;text-align:right;color:#292524">${escapeHtml(formatRupiah(item.price * item.quantity))}</td></tr>`
    ).join("");
    const tracking = payload.trackingNumber
        ? `<div style="margin-top:20px;padding:16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px"><div style="font-size:12px;color:#78716c">INFORMASI PENGIRIMAN</div><div style="margin-top:8px"><strong>Kurir:</strong> ${escapeHtml(payload.shippingCourier || "-")}</div><div style="margin-top:4px"><strong>Nomor resi:</strong> ${escapeHtml(payload.trackingNumber)}</div>${trackingUrl ? `<div style="margin-top:12px"><a href="${escapeHtml(trackingUrl)}" style="display:inline-block;background:#92400e;color:#fff;text-decoration:none;padding:10px 15px;border-radius:6px;font-weight:600">Lacak pesanan</a></div>` : ""}</div>`
        : "";

    return `<div style="margin:0;background:#f7f4ef;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;color:#292524"><div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e7e5e4;border-radius:12px;overflow:hidden"><div style="background:#78350f;padding:22px 28px;color:#fff"><div style="font-size:20px;font-weight:700">Mutiara Abadi Snack</div><div style="font-size:12px;margin-top:5px;color:#fef3c7">Notifikasi pesanan dari website Mutiara Abadi Snack</div></div><div style="padding:28px"><p style="margin:0 0 8px">Halo,</p><h1 style="font-size:20px;line-height:1.35;margin:0 0 8px;color:#292524">${codCreated ? "Pesanan COD berhasil dicatat" : "Pembaruan pesanan"}</h1><p style="margin:0;color:#57534e">Pesanan <strong>${escapeHtml(payload.orderNumber)}</strong> ${codCreated ? "telah berhasil dicatat di website kami." : "memiliki pembaruan terbaru."}</p><div style="display:inline-block;margin-top:16px;padding:8px 12px;border-radius:20px;background:#fef3c7;color:#78350f;font-size:13px;font-weight:700">${escapeHtml(status)}</div><h2 style="font-size:14px;margin:26px 0 8px;color:#44403c">Rincian pesanan</h2><table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="color:#78716c;text-align:left"><th style="padding:8px">Produk</th><th style="padding:8px;text-align:center">Jumlah</th><th style="padding:8px;text-align:right">Nilai</th></tr></thead><tbody>${rows}</tbody></table><div style="text-align:right;padding:16px 8px;font-size:16px;font-weight:700;color:#78350f">Total pesanan: ${escapeHtml(formatRupiah(payload.total))}</div>${tracking}<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#57534e">Terima kasih telah mempercayakan pesanan Anda kepada Mutiara Abadi Snack.</p></div><div style="padding:16px 28px;background:#fafaf9;border-top:1px solid #e7e5e4;color:#78716c;font-size:11px">Email ini dikirim otomatis oleh website Mutiara Abadi Snack. Mohon jangan membalas email ini.</div></div></div>`;
}

/**
 * Log-safe recipient (never the full address).
 */
function maskEmail(email: string): string {
    const [local, domain] = email.split("@");

    if (!domain) {
        return "***";
    }

    const head = local.slice(0, 2);

    return `${head}${"*".repeat(Math.max(local.length - 2, 1))}@${domain}`;
}
