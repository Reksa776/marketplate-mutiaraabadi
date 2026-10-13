/**
 * ==========================================
 * MOCK NOTIFICATION PROVIDER
 * ==========================================
 *
 * Mock provider untuk Phase 1 testing.
 * Tidak melakukan external API call.
 *
 * Nantinya akan diganti/ditambah dengan:
 * - BaileysWhatsAppProvider (Phase 2)
 * - EmailProvider
 * - SmsProvider
 */

import {
    isRawMessagePayload,
    type NotificationPayload,
    type SendNotificationResult,
} from "./types";
import type { NotificationProvider } from "./provider";

type MockProviderOptions = {
    /**
     * Jika true, semua notification
     * akan gagal (simulasi provider error).
     */
    simulateFailure?: boolean;

    /**
     * Delay simulated dalam ms.
     */
    delayMs?: number;
};

export class MockNotificationProvider
    implements NotificationProvider
{
    readonly name = "mock";

    private options: MockProviderOptions;

    constructor(
        options: MockProviderOptions = {}
    ) {
        this.options = options;
    }

    isConfigured(): boolean {
        return true;
    }

    async send(
        payload: NotificationPayload
    ): Promise<SendNotificationResult> {
        /**
         * Simulate network delay.
         */
        if (this.options.delayMs) {
            await new Promise((resolve) =>
                setTimeout(
                    resolve,
                    this.options.delayMs
                )
            );
        }

        /**
         * Simulate provider failure.
         */
        if (this.options.simulateFailure) {
            console.log(
                `[MOCK] Notification FAILED (simulated) for order ${payload.orderNumber} | ` +
                    `Type: ${payload.notificationType}`
            );

            return {
                success: false,
                errorCode: "MOCK_SIMULATED_FAILURE",
                errorMessage:
                    "Simulated provider failure for testing",
            };
        }

        /**
         * Simulate successful send.
         *
         * NEVER log a raw message: it can contain an OTP. Only the
         * fact and shape of the delivery is logged.
         */
        console.log(
            `[MOCK] Notification SENT to ${payload.recipient} | ` +
                `Order: ${payload.orderNumber} | ` +
                `Type: ${payload.notificationType} | ` +
                (isRawMessagePayload(payload)
                    ? `Payload: raw message (${payload.rawMessage.length} chars, redacted)`
                    : `Status: ${payload.previousStatus} → ${payload.newStatus}`)
        );

        return {
            success: true,
            providerMessageId: `mock_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        };
    }
}
