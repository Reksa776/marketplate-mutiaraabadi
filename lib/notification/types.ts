/**
 * ==========================================
 * NOTIFICATION TYPES
 * ==========================================
 *
 * Provider-agnostic notification types.
 * Phase 1 foundation.
 */

export type NotificationChannel =
    | "whatsapp"
    | "email"
    | "sms"
    | "push";

export type NotificationType =
    | "ORDER_STATUS_CHANGED"
    /**
     * Guest order recovery OTP. Carries a RAW, purpose-built message
     * (the code) instead of an order-status template, and is delivered
     * SYNCHRONOUSLY so the caller can fail closed when the provider
     * refuses the message.
     */
    | "GUEST_RECOVERY_OTP";

export type NotificationStatus =
    | "QUEUED"
    | "PROCESSING"
    | "SENT"
    | "FAILED";

/**
 * Event yang dihasilkan ketika
 * order status berubah.
 */
export type OrderStatusChangedEvent = {
    orderId: number;
    orderNumber: string;
    userId: string | null;
    recipientPhone: string;
    previousStatus: string;
    newStatus: string;
    total: number;
    items: Array<{
        productName: string;
        variantName: string;
        quantity: number;
        price: number;
    }>;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
    shippingCourier?: string | null;
    timestamp: Date;
};

/**
 * Data yang dibutuhkan oleh
 * NotificationProvider untuk
 * mengirim notification.
 */
export type SendNotificationPayload = {
    notificationId: number;
    channel: NotificationChannel;
    notificationType: NotificationType;
    recipient: string;
    orderId: number;
    orderNumber: string;
    previousStatus: string;
    newStatus: string;
    total: number;
    items: Array<{
        productName: string;
        variantName: string;
        quantity: number;
        price: number;
    }>;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
    shippingCourier?: string | null;
};

/**
 * ==========================================
 * RAW MESSAGE NOTIFICATION
 * ==========================================
 *
 * A notification whose body is supplied by the caller instead of the
 * order-status template (today: the guest recovery OTP).
 *
 * SECURITY: `rawMessage` may contain a one-time code, so it is used
 * ONLY in memory for the provider call. It is never written to the
 * Notification row, never logged and never returned in a response.
 */
export type RawMessageNotificationPayload = {
    notificationId: number;
    channel: NotificationChannel;
    notificationType: NotificationType;
    recipient: string;
    orderId: number;
    orderNumber: string;
    rawMessage: string;
};

/**
 * Every payload a NotificationProvider can be asked to send.
 */
export type NotificationPayload =
    | SendNotificationPayload
    | RawMessageNotificationPayload;

/**
 * Discriminate a raw-message payload from an order-status payload.
 */
export function isRawMessagePayload(
    payload: NotificationPayload
): payload is RawMessageNotificationPayload {
    return (
        typeof (
            payload as RawMessageNotificationPayload
        ).rawMessage === "string"
    );
}

/**
 * Response dari NotificationProvider
 * setelah mengirim notification.
 */
export type SendNotificationResult = {
    success: boolean;
    providerMessageId?: string;
    errorCode?: string;
    errorMessage?: string;
    /**
     * Notification row id, when the caller needs it for an audit trail
     * (the guest recovery challenge records which message carried the
     * OTP). Never contains the message body.
     */
    notificationId?: number;
};

/**
 * Notification record di database.
 */
export type NotificationRecord = {
    id: number;
    orderId: number | null;
    userId: string | null;
    channel: string;
    notificationType: string;
    recipient: string;
    idempotencyKey: string;
    providerMessageId: string | null;
    payload: string | null;
    status: NotificationStatus;
    errorCode: string | null;
    errorMessage: string | null;
    retryCount: number;
    maxRetries: number;
    createdAt: Date;
    updatedAt: Date;
};
