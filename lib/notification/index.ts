/**
 * ==========================================
 * NOTIFICATION MODULE
 * ==========================================
 *
 * Public exports untuk Phase 1
 * notification foundation.
 */

export { NotificationService } from "./service";
export type {
    NotificationProvider,
} from "./provider";
export { MockNotificationProvider } from "./mock-provider";
// BaileysWhatsAppProvider is intentionally NOT exported here.
// It must only be loaded via dynamic import() to prevent
// @whiskeysockets/baileys from entering the Turbopack
// static dependency graph. Import directly from:
//   const { BaileysWhatsAppProvider } = await import("@/lib/notification/baileys-provider");
export { NotificationQueue } from "./queue";
export { getNotificationQueue } from "./queue";
export {
    onOrderStatusChanged,
    onShipmentStatusChanged,
} from "./order-status-handler";
export type {
    NotificationChannel,
    NotificationType,
    NotificationStatus,
    OrderStatusChangedEvent,
    SendNotificationPayload,
    SendNotificationResult,
} from "./types";
