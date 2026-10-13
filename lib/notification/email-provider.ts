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
    type SendNotificationResult,
} from "./types";
import type { NotificationProvider } from "./provider";

/** Same shape the checkout form accepts for a guest email. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RECOVERY_SUBJECT =
    "Kode Verifikasi Akses Pesanan";

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

        const subject = isRawMessagePayload(payload)
            ? RECOVERY_SUBJECT
            : `Pesanan ${payload.orderNumber} — Update Status`;

        const result = await sendMail({
            to,
            subject,
            text,
            html: textToHtml(text),
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

    return [
        "Update Pesanan",
        "",
        `Pesanan: ${payload.orderNumber}`,
        `Status: ${payload.newStatus}`,
        "",
        "Terima kasih telah berbelanja.",
    ].join("\n");
}

/**
 * Minimal HTML part: escape everything (the code is numeric, but the
 * order number is data) and keep the line breaks.
 */
function textToHtml(text: string): string {
    const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111827">${escaped.replace(/\n/g, "<br/>")}</div>`;
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
