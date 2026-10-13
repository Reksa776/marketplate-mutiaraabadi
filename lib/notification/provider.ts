/**
 * ==========================================
 * NOTIFICATION PROVIDER
 * ==========================================
 *
 * Abstract interface untuk notification provider.
 * Phase 1 foundation.
 *
 * Setiap provider (WhatsApp, Email, SMS, dll)
 * harus mengimplementasi interface ini.
 */

import type {
    NotificationPayload,
    SendNotificationResult,
} from "./types";

export interface NotificationProvider {
    /**
     * Nama provider untuk logging.
     */
    readonly name: string;

    /**
     * Kirim notification.
     *
     * Provider harus:
     * 1. Mengirim notification ke recipient
     * 2. Mengembalikan result dengan status
     * 3. Tidak throw error (handle error internal)
     */
    send(
        payload: NotificationPayload
    ): Promise<SendNotificationResult>;

    /**
     * Validasi apakah provider
     * sudah dikonfigurasi dengan benar.
     */
    isConfigured(): boolean;
}
