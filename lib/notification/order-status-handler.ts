/**
 * ==========================================
 * ORDER STATUS HANDLER
 * ==========================================
 *
 * Hook untuk mendeteksi perubahan
 * status order dan memicu notification.
 *
 * Phase 1 foundation.
 *
 * CRITICAL ARCHITECTURE NOTE:
 * BaileysWhatsAppProvider is loaded via dynamic
 * import() inside createProvider() to prevent
 * @whiskeysockets/baileys from entering the
 * Turbopack/Next.js static dependency graph.
 * This keeps Baileys completely isolated as a
 * server-only dependency that never leaks into
 * unrelated routes (order API, auth session, etc).
 */

import { prisma } from "@/lib/prisma";
import { shipmentStatusToEventKey } from "@/lib/mengantar/status";
import { NotificationService } from "./service";
import { MockNotificationProvider } from "./mock-provider";
import { EmailNotificationProvider } from "./email-provider";
import { getNotificationQueue } from "./queue";
import type { OrderStatusChangedEvent } from "./types";
import type { SendNotificationPayload } from "./types";
import type {
    NotificationChannel,
    NotificationType,
    SendNotificationResult,
} from "./types";
import type { NotificationProvider } from "./provider";

/**
 * ==========================================
 * SINGLETON NOTIFICATION SERVICE
 * ==========================================
 *
 * Provider selection via environment variable:
 *   NOTIFICATION_PROVIDER=mock   (default, Phase 1)
 *   NOTIFICATION_PROVIDER=whatsapp (Phase 2, Baileys)
 */

let notificationService: NotificationService | null = null;

/**
 * Lazily create the notification provider.
 *
 * When NOTIFICATION_PROVIDER=whatsapp, dynamically
 * imports BaileysWhatsAppProvider so that Baileys
 * and its dependencies (jimp, etc.) are never
 * part of the static module graph.
 *
 * When NOTIFICATION_PROVIDER=mock (or unset),
 * MockNotificationProvider is used directly —
 * Baileys is never loaded.
 */
async function createProvider(): Promise<NotificationProvider> {
    const providerType =
        process.env.NOTIFICATION_PROVIDER || "mock";

    if (providerType === "whatsapp") {
        console.log(
            "[NOTIFICATION] Loading BaileysWhatsAppProvider (dynamic import)"
        );
        const { BaileysWhatsAppProvider } = await import("./baileys-provider");
        return new BaileysWhatsAppProvider();
    }

    console.log(
        "[NOTIFICATION] Using MockNotificationProvider"
    );
    return new MockNotificationProvider();
}

/**
 * Lazily create the provider for the EMAIL channel.
 *
 * Selection mirrors the WhatsApp branch, with one twist: when
 * NOTIFICATION_PROVIDER=mock (the development default) the email
 * channel is mocked as well, so local runs and the E2E harness never
 * touch a real mailbox. With any real provider selected, the email
 * channel uses EmailNotificationProvider — and if the SMTP mailbox is
 * not provisioned, `isConfigured()` is false and the send FAILS
 * CLOSED (never a silent success).
 *
 * EmailNotificationProvider itself is safe to import statically: it
 * reaches nodemailer only through a dynamic import() in lib/mailer.ts,
 * so the SMTP client stays out of the static dependency graph.
 */
async function createEmailProvider(): Promise<NotificationProvider> {
    const providerType =
        process.env.NOTIFICATION_PROVIDER || "mock";

    if (providerType === "mock") {
        console.log(
            "[NOTIFICATION] Using MockNotificationProvider (email channel)"
        );
        return new MockNotificationProvider();
    }

    console.log(
        "[NOTIFICATION] Using EmailNotificationProvider"
    );
    return new EmailNotificationProvider();
}

/**
 * Initialize the singleton NotificationService.
 *
 * Uses async provider creation to support
 * dynamic import of Baileys when needed.
 */
async function initializeService(): Promise<NotificationService> {
    if (!notificationService) {
        const provider = await createProvider();
        const emailProvider =
            await createEmailProvider();

        notificationService = new NotificationService({
            provider,
            channel: "whatsapp",
            emailProvider,
        });
    }

    return notificationService;
}

/**
 * Get the singleton NotificationService.
 *
 * On first call, initializes the service
 * (including dynamic provider loading).
 * Subsequent calls return the cached instance.
 */
let initPromise: Promise<NotificationService> | null = null;

function getNotificationService(): Promise<NotificationService> {
    if (!initPromise) {
        initPromise = initializeService();
    }
    return initPromise;
}

/**
 * ==========================================
 * SEND A RAW NOTIFICATION NOW (SYNCHRONOUS)
 * ==========================================
 *
 * Delivers a caller-supplied message through the SAME provider
 * selection as the order-status pipeline (mock in development,
 * Baileys WhatsApp in production) and RETURNS the provider result.
 *
 * Used by the guest order recovery OTP, which must FAIL CLOSED: a
 * one-time code may only be considered delivered when the provider
 * accepted it. The queue worker is deliberately NOT initialised —
 * there is nothing to queue for a synchronous send.
 */
export async function sendRawNotificationNow(input: {
    orderId: number;
    userId?: string | null;
    channel: NotificationChannel;
    notificationType: NotificationType;
    recipient: string;
    orderNumber: string;
    idempotencyKey: string;
    rawMessage: string;
}): Promise<SendNotificationResult> {
    const service = await getNotificationService();

    return service.sendRawMessageNow(input);
}

/**
 * ==========================================
 * WORKER INITIALIZATION
 * ==========================================
 *
 * Auto-initialize queue worker
 * saat pertama kali dipanggil.
 */

let workerInitialized = false;

async function ensureWorkerInitialized(): Promise<void> {
    if (workerInitialized) {
        return;
    }

    workerInitialized = true;

    const queue = getNotificationQueue();
    const service = await getNotificationService();

    queue.onProcess(
        async (payload: SendNotificationPayload) => {
            await service.processNotification(payload);
        }
    );

    console.log(
        "[NOTIFICATION] Worker initialized"
    );
}

/**
 * ==========================================
 * ON ORDER STATUS CHANGED
 * ==========================================
 *
 * Dipanggil dari:
 * 1. Admin order status update (PATCH)
 * 2. Payment webhook (notification)
 * 3. COD order creation
 *
 * Fungsi ini:
 * 1. Mengambil data order lengkap
 * 2. Membuat OrderStatusChangedEvent
 * 3. Memanggil NotificationService
 *
 * ERROR HANDLING:
 * Notification failure TIDAK boleh
 * menyebabkan order gagal.
 * Semua error ditangkap dan dilog.
 */
export async function onOrderStatusChanged(
    orderId: number,
    previousStatus: string,
    newStatus: string
): Promise<void> {
    try {
        /**
         * Pastikan worker sudah initialized.
         */
        await ensureWorkerInitialized();

        /**
         * Ambil data order lengkap
         * untuk notification payload.
         */
        const order =
            await prisma.order.findUnique({
                where: { id: orderId },
                include: {
                    items: {
                        select: {
                            productName: true,
                            variantName: true,
                            quantity: true,
                            price: true,
                        },
                    },
                },
            });

        if (!order) {
            console.error(
                `[ORDER STATUS HANDLER] Order not found: ${orderId}`
            );
            return;
        }

        /**
         * Buat event.
         */
        const event: OrderStatusChangedEvent = {
            orderId: order.id,
            orderNumber: order.orderNumber,
            userId: order.userId,
            recipientPhone: order.phone,
            previousStatus,
            newStatus,
            total: Number(order.total),
            items: order.items.map((item) => ({
                productName: item.productName,
                variantName: item.variantName,
                quantity: item.quantity,
                price: Number(item.price),
            })),
            trackingNumber: order.trackingNumber,
            trackingUrl: order.trackingUrl,
            shippingCourier: order.shippingCourier,
            timestamp: new Date(),
        };

        console.log(
            `[ORDER STATUS HANDLER] Order ${order.orderNumber} | ` +
                `${previousStatus} → ${newStatus}`
        );

        /**
         * Kirim ke NotificationService.
         */
        const service = await getNotificationService();

        await service.handleOrderStatusChanged(event);
    } catch (error) {
        /**
         * ==========================================
         * CRITICAL: Error handling
         * ==========================================
         *
         * Notification error TIDAK boleh
         * mengganggu order flow.
         *
         * Log error dan return.
         */
        console.error(
            `[ORDER STATUS HANDLER] Error for order ${orderId}:`,
            error
        );
    }
}

/**
 * ==========================================
 * ON SHIPMENT STATUS CHANGED
 * ==========================================
 *
 * Shipment fulfilment events (Mengantar webhook / admin shipment
 * actions) reuse the EXISTING notification pipeline. We do NOT
 * build a second notification system: the same
 * NotificationService, queue, provider, and idempotency key are
 * used — only the status namespace differs (`SHIPMENT_*`), so a
 * shipment event can never collide with an order-status event.
 *
 * Called from:
 * 1. Mengantar webhook (provider status change)
 * 2. Admin shipment create / pay-unpaid actions
 *
 * ERROR HANDLING: notification failure never breaks fulfilment.
 */
export async function onShipmentStatusChanged(
    orderId: number,
    previousShipmentStatus: string | null,
    newShipmentStatus: string
): Promise<void> {
    try {
        const newEventKey =
            shipmentStatusToEventKey(newShipmentStatus);

        // Non-notifiable shipment states (e.g. CREATING/PAYING
        // transient locks) are intentionally silent.
        if (!newEventKey) {
            return;
        }

        const previousEventKey =
            shipmentStatusToEventKey(previousShipmentStatus) ??
            "NONE";

        await ensureWorkerInitialized();

        const order =
            await prisma.order.findUnique({
                where: { id: orderId },
                include: {
                    items: {
                        select: {
                            productName: true,
                            variantName: true,
                            quantity: true,
                            price: true,
                        },
                    },
                },
            });

        if (!order) {
            console.error(
                `[SHIPMENT STATUS HANDLER] Order not found: ${orderId}`
            );
            return;
        }

        const event: OrderStatusChangedEvent = {
            orderId: order.id,
            orderNumber: order.orderNumber,
            userId: order.userId,
            recipientPhone: order.phone,
            previousStatus: previousEventKey,
            newStatus: newEventKey,
            total: Number(order.total),
            items: order.items.map((item) => ({
                productName: item.productName,
                variantName: item.variantName,
                quantity: item.quantity,
                price: Number(item.price),
            })),
            trackingNumber: order.trackingNumber,
            trackingUrl: order.trackingUrl,
            shippingCourier: order.shippingCourier,
            timestamp: new Date(),
        };

        console.log(
            `[SHIPMENT STATUS HANDLER] Order ${order.orderNumber} | ` +
                `${previousShipmentStatus} → ${newShipmentStatus}`
        );

        const service = await getNotificationService();

        await service.handleOrderStatusChanged(event);
    } catch (error) {
        console.error(
            `[SHIPMENT STATUS HANDLER] Error for order ${orderId}:`,
            error
        );
    }
}
