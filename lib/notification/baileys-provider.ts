/**
 * ==========================================
 * BAILEYS WHATSAPP PROVIDER
 * ==========================================
 *
 * NotificationProvider implementation
 * using Baileys for WhatsApp delivery.
 *
 * IMPORTANT: This module is loaded ONLY via
 * dynamic import() from order-status-handler.ts
 * to prevent Baileys from entering the Turbopack
 * static dependency graph.
 *
 * Flow:
 * NotificationService
 *   → BaileysWhatsAppProvider.send()
 *     → validate recipient
 *     → check connection
 *     → normalize phone
 *     → generate message
 *     → send via WhatsAppService
 *     → return result
 */

/**
 * Runtime guard: prevent accidental client import.
 */
if (typeof window !== "undefined") {
    throw new Error(
        "@/lib/notification/baileys-provider must only be imported on the server."
    );
}

import type {
    NotificationPayload,
    SendNotificationResult,
} from "@/lib/notification/types";
import type { NotificationProvider } from "@/lib/notification/provider";
import {
    getWhatsAppService,
    type SendMessageResult,
} from "@/lib/whatsapp/service";
import {
    normalizePhone,
    normalizePhoneToJid,
    isValidIndonesianPhone,
} from "@/lib/whatsapp/phone";
import {
    generateNotificationMessage,
} from "@/lib/whatsapp/message";

export class BaileysWhatsAppProvider
    implements NotificationProvider
{
    readonly name = "baileys-whatsapp";

    /**
     * Check if the provider is configured.
     *
     * Baileys doesn't need API keys —
     * it needs a WhatsApp session.
     */
    isConfigured(): boolean {
        const service = getWhatsAppService();
        const status = service.getStatus();
        return status.status === "CONNECTED";
    }

    /**
     * Send a WhatsApp notification.
     */
    async send(
        payload: NotificationPayload
    ): Promise<SendNotificationResult> {
        try {
            // ==========================================
            // 1. CHECK CONNECTION
            // ==========================================
            const service = getWhatsAppService();
            const status = service.getStatus();

            if (status.status !== "CONNECTED") {
                return {
                    success: false,
                    errorCode: "NOT_CONNECTED",
                    errorMessage: `WhatsApp is ${status.status.toLowerCase()}`,
                };
            }

            // ==========================================
            // 2. VALIDATE RECIPIENT
            // ==========================================
            const recipient = payload.recipient;

            if (
                !recipient ||
                !isValidIndonesianPhone(recipient)
            ) {
                return {
                    success: false,
                    errorCode: "INVALID_RECIPIENT",
                    errorMessage: `Invalid phone number: ${recipient}`,
                };
            }

            // ==========================================
            // 3. NORMALIZE PHONE → JID
            // ==========================================
            const jid =
                normalizePhoneToJid(recipient);

            if (!jid) {
                return {
                    success: false,
                    errorCode: "NORMALIZATION_FAILED",
                    errorMessage: `Failed to normalize phone: ${recipient}`,
                };
            }

            // ==========================================
            // 4. GENERATE MESSAGE
            // ==========================================
            //
            // A raw-message payload (OTP) is sent verbatim; an
            // order-status payload renders the shared template.
            const message =
                generateNotificationMessage(payload);

            // ==========================================
            // 5. SEND MESSAGE
            // ==========================================
            const result: SendMessageResult =
                await service.sendMessage(jid, message);

            if (result.success) {
                return {
                    success: true,
                    providerMessageId:
                        result.messageId,
                };
            } else {
                return {
                    success: false,
                    errorCode:
                        result.errorCode ||
                        "BAILEYS_ERROR",
                    errorMessage:
                        result.errorMessage ||
                        "Unknown Baileys error",
                };
            }
        } catch (error) {
            return {
                success: false,
                errorCode: "PROVIDER_EXCEPTION",
                errorMessage:
                    error instanceof Error
                        ? error.message
                        : "Unknown error in BaileysWhatsAppProvider",
            };
        }
    }
}
