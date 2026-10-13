/**
 * ==========================================
 * NOTIFICATION SERVICE
 * ==========================================
 *
 * Orchestrator untuk notification system.
 *
 * Flow:
 * Event → Create Record → Queue Job → Process → Provider → Update Status
 *
 * Phase 1 foundation.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getNotificationQueue } from "./queue";
import type { NotificationProvider } from "./provider";
import type {
    NotificationChannel,
    NotificationPayload,
    NotificationType,
    NotificationStatus,
    OrderStatusChangedEvent,
    RawMessageNotificationPayload,
    SendNotificationPayload,
    SendNotificationResult,
} from "./types";

type NotificationServiceOptions = {
    provider: NotificationProvider;
    channel: NotificationChannel;
};

export class NotificationService {
    private provider: NotificationProvider;
    private channel: NotificationChannel;

    constructor(
        options: NotificationServiceOptions
    ) {
        this.provider = options.provider;
        this.channel = options.channel;
    }

    /**
     * ==========================================
     * HANDLE ORDER STATUS CHANGED
     * ==========================================
     *
     * Entry point utama.
     * Dipanggil dari admin order update
     * atau payment webhook.
     *
     * 1. Buat notification record (idempotent)
     * 2. Queue job
     * 3. Return — tidak menunggu
     */
    async handleOrderStatusChanged(
        event: OrderStatusChangedEvent
    ): Promise<void> {
        const notificationType: NotificationType =
            "ORDER_STATUS_CHANGED";

        /**
         * Generate idempotency key.
         *
         * Format: order_{orderId}_{oldStatus}_{newStatus}
         *
         * Ini memastikan satu transisi status
         * hanya menghasilkan satu notification.
         */
        const idempotencyKey =
            this.generateIdempotencyKey(
                event.orderId,
                event.previousStatus,
                event.newStatus
            );

        /**
         * ==========================================
     * IDEMPOTENCY CHECK
         * ==========================================
         *
         * Cek apakah notification untuk
         * transisi ini sudah ada.
         */
        const existing =
            await prisma.notification.findUnique(
                {
                    where: {
                        idempotencyKey,
                    },
                    select: {
                        id: true,
                        status: true,
                    },
                }
            );

        if (existing) {
            console.log(
                `[NOTIFICATION] Duplicate event detected | ` +
                    `Order: ${event.orderNumber} | ` +
                    `Key: ${idempotencyKey} | ` +
                    `Existing status: ${existing.status}`
            );
            return;
        }

        /**
         * ==========================================
     * CREATE NOTIFICATION RECORD
         * ==========================================
         *
         * Buat record di database.
         * Status awal: QUEUED.
         */
        const notification =
            await prisma.notification.create({
                data: {
                    orderId: event.orderId,
                    userId: event.userId,
                    channel: this.channel,
                    notificationType,
                    recipient: event.recipientPhone,
                    idempotencyKey,
                    status: "QUEUED",
                    payload: JSON.stringify({
                        orderNumber: event.orderNumber,
                        previousStatus:
                            event.previousStatus,
                        newStatus: event.newStatus,
                        total: event.total,
                        items: event.items,
                        trackingNumber:
                            event.trackingNumber,
                        trackingUrl: event.trackingUrl,
                        shippingCourier:
                            event.shippingCourier,
                    }),
                },
                select: {
                    id: true,
                },
            });

        console.log(
            `[NOTIFICATION] Created | ` +
                `ID: ${notification.id} | ` +
                `Order: ${event.orderNumber} | ` +
                `Type: ${notificationType} | ` +
                `Recipient: ${event.recipientPhone}`
        );

        /**
         * ==========================================
     * QUEUE JOB
         * ==========================================
         *
         * Tambah job ke queue.
         * Job akan diproses oleh worker.
         */
        const queue = getNotificationQueue();

        queue.enqueue(
            {
                notificationId: notification.id,
                channel: this.channel,
                notificationType,
                recipient: event.recipientPhone,
                orderId: event.orderId,
                orderNumber: event.orderNumber,
                previousStatus: event.previousStatus,
                newStatus: event.newStatus,
                total: event.total,
                items: event.items,
                trackingNumber: event.trackingNumber,
                trackingUrl: event.trackingUrl,
                shippingCourier: event.shippingCourier,
            } satisfies SendNotificationPayload,
            {
                maxAttempts: 3,
            }
        );
    }

    /**
     * ==========================================
     * PROCESS NOTIFICATION JOB
     * ==========================================
     *
     * Dipanggil oleh queue worker.
     * Update status record dan kirim
     * via provider.
     */
    async processNotification(
        payload: SendNotificationPayload
    ): Promise<void> {
        await this.deliver(payload);
    }

    /**
     * ==========================================
     * SEND A RAW MESSAGE NOW (SYNCHRONOUS)
     * ==========================================
     *
     * Creates the Notification record and delivers it IMMEDIATELY,
     * returning the provider result so the caller can FAIL CLOSED.
     *
     * Used by the guest order recovery OTP: the code may only be
     * treated as "sent" when the provider actually accepted it, so the
     * queue (fire-and-forget, in-memory, retries after the caller has
     * already answered) must not be involved.
     *
     * The raw message is NEVER persisted: `payload` stores only the
     * fact and purpose of the delivery, so a leaked database row can
     * never reveal an OTP.
     */
    async sendRawMessageNow(input: {
        orderId: number;
        userId?: string | null;
        channel: NotificationChannel;
        notificationType: NotificationType;
        recipient: string;
        orderNumber: string;
        idempotencyKey: string;
        rawMessage: string;
    }): Promise<SendNotificationResult> {
        const select = {
            id: true,
            status: true,
            errorCode: true,
            errorMessage: true,
        } as const;

        let record = await prisma.notification.findUnique(
            {
                where: {
                    idempotencyKey:
                        input.idempotencyKey,
                },
                select,
            }
        );

        /*
         * Already delivered under this key: report success without
         * sending a second message. (A caller that needs a NEW code
         * must use a NEW key — which the recovery flow does, one key
         * per challenge.)
         */
        if (record && record.status === "SENT") {
            return { success: true };
        }

        if (!record) {
            try {
                record = await prisma.notification.create({
                    data: {
                        orderId: input.orderId,
                        userId:
                            input.userId ?? null,
                        channel: input.channel,
                        notificationType:
                            input.notificationType,
                        recipient: input.recipient,
                        idempotencyKey:
                            input.idempotencyKey,
                        status: "QUEUED",
                        /*
                         * Deliberately WITHOUT the raw message.
                         */
                        payload: JSON.stringify({
                            orderNumber:
                                input.orderNumber,
                            purpose:
                                input.notificationType,
                        }),
                    },
                    select,
                });
            } catch (error) {
                /*
                 * Concurrent duplicate: re-read the winning row
                 * rather than failing the caller.
                 */
                if (
                    error instanceof
                        Prisma.PrismaClientKnownRequestError &&
                    error.code === "P2002"
                ) {
                    record =
                        await prisma.notification.findUnique(
                            {
                                where: {
                                    idempotencyKey:
                                        input.idempotencyKey,
                                },
                                select,
                            }
                        );

                    if (record?.status === "SENT") {
                        return { success: true };
                    }
                } else {
                    throw error;
                }
            }
        }

        if (!record) {
            return {
                success: false,
                errorCode: "NOTIFICATION_RECORD_MISSING",
                errorMessage:
                    "Notification record tidak dapat dibuat.",
            };
        }

        const payload: RawMessageNotificationPayload = {
            notificationId: record.id,
            channel: input.channel,
            notificationType: input.notificationType,
            recipient: input.recipient,
            orderId: input.orderId,
            orderNumber: input.orderNumber,
            rawMessage: input.rawMessage,
        };

        return this.deliver(payload);
    }

    /**
     * ==========================================
     * SHARED DELIVERY PRIMITIVE
     * ==========================================
     *
     * PROCESSING → provider.send() → SENT (or FAILED + reason).
     * Returns the provider result instead of throwing, so a
     * synchronous caller can fail closed and the queue worker can
     * simply ignore it.
     */
    private async deliver(
        payload: NotificationPayload
    ): Promise<SendNotificationResult> {
        const { notificationId } = payload;

        /**
         * ==========================================
     * UPDATE STATUS → PROCESSING
         * ==========================================
         */
        await prisma.notification.update({
            where: { id: notificationId },
            data: {
                status: "PROCESSING",
            },
        });

        console.log(
            `[NOTIFICATION] Processing | ` +
                `ID: ${notificationId} | ` +
                `Order: ${payload.orderNumber}`
        );

        /**
         * ==========================================
     * VALIDATE PROVIDER
         * ==========================================
         */
        if (!this.provider.isConfigured()) {
            await this.markFailed(
                notificationId,
                "PROVIDER_NOT_CONFIGURED",
                "Provider belum dikonfigurasi"
            );

            return {
                success: false,
                errorCode: "PROVIDER_NOT_CONFIGURED",
                errorMessage:
                    "Provider belum dikonfigurasi",
            };
        }

        /**
         * ==========================================
     * SEND VIA PROVIDER
         * ==========================================
         */
        const result =
            await this.provider.send(payload);

        if (result.success) {
            /**
             * ==========================================
         * SUCCESS
         * ==========================================
         */
            await prisma.notification.update({
                where: { id: notificationId },
                data: {
                    status: "SENT",
                    providerMessageId:
                        result.providerMessageId ?? null,
                },
            });

            console.log(
                `[NOTIFICATION] Sent | ` +
                    `ID: ${notificationId} | ` +
                    `Provider Message ID: ${result.providerMessageId ?? "N/A"}`
            );

            return { ...result, notificationId };
        } else {
            /**
             * ==========================================
         * PROVIDER FAILURE
         * ==========================================
         */
            await this.markFailed(
                notificationId,
                result.errorCode ?? "PROVIDER_ERROR",
                result.errorMessage ??
                    "Unknown provider error"
            );

            return { ...result, notificationId };
        }
    }

    /**
     * ==========================================
     * MARK FAILED
     * ==========================================
     *
     * Tandai notification sebagai gagal.
     */
    private async markFailed(
        notificationId: number,
        errorCode: string,
        errorMessage: string
    ): Promise<void> {
        await prisma.notification.update({
            where: { id: notificationId },
            data: {
                status: "FAILED",
                errorCode,
                errorMessage,
            },
        });

        console.error(
            `[NOTIFICATION] Failed | ` +
                `ID: ${notificationId} | ` +
                `Code: ${errorCode} | ` +
                `Message: ${errorMessage}`
        );
    }

    /**
     * ==========================================
     * GENERATE IDEMPOTENCY KEY
     * ==========================================
     *
     * Format: notif_order_{orderId}_{old}_{new}
     *
     * Memastikan satu transisi status
     * hanya menghasilkan satu notification.
     */
    private generateIdempotencyKey(
        orderId: number,
        previousStatus: string,
        newStatus: string
    ): string {
        return `notif_order_${orderId}_${previousStatus}_${newStatus}`;
    }
}
