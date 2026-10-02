/**
 * ==========================================
 * MENGANTAR SHIPMENT — WHATSAPP NOTIFICATION
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-notification.test.ts
 *
 * Proves the EXISTING notification pipeline gives one WhatsApp per
 * real shipment transition (never per duplicate webhook / worker
 * retry), that the message carries the resi + courier, and that no
 * provider credential can ever appear in a message.
 */

jest.mock("@/lib/prisma", () => ({
    prisma: {
        notification: {
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock("@/lib/notification/queue", () => ({
    getNotificationQueue: jest.fn(),
    NotificationQueue: class {},
}));

import { readFileSync } from "fs";

import {
    generateOrderStatusMessage,
} from "@/lib/whatsapp/message";
import { shipmentStatusToEventKey } from "@/lib/mengantar/status";
import { NotificationService } from "@/lib/notification/service";
import { MockNotificationProvider } from "@/lib/notification/mock-provider";
import type { SendNotificationPayload } from "@/lib/notification/types";

const prisma = (
    require("@/lib/prisma") as {
        prisma: {
            notification: {
                findUnique: jest.Mock;
                create: jest.Mock;
                update: jest.Mock;
            };
        };
    }
).prisma;

const enqueue = jest.fn();
(
    require("@/lib/notification/queue") as {
        getNotificationQueue: jest.Mock;
    }
).getNotificationQueue.mockReturnValue({ enqueue });

function shipmentPayload(
    overrides: Partial<SendNotificationPayload> = {}
): SendNotificationPayload {
    return {
        notificationId: 1,
        channel: "whatsapp",
        notificationType: "ORDER_STATUS_CHANGED",
        recipient: "081234567890",
        orderId: 10,
        orderNumber: "ORD-10",
        previousStatus: "SHIPMENT_CREATED",
        newStatus: "SHIPMENT_PICKED_UP",
        total: 110000,
        items: [
            {
                productName: "Kaos",
                variantName: "L",
                quantity: 1,
                price: 110000,
            },
        ],
        trackingNumber: "CN-777",
        trackingUrl: null,
        shippingCourier: "jne",
        ...overrides,
    };
}

describe("shipment status → notification event", () => {
    it("notifies every fulfilment transition", () => {
        expect(shipmentStatusToEventKey("CREATED")).toBe(
            "SHIPMENT_CREATED"
        );
        expect(shipmentStatusToEventKey("PICKED_UP")).toBe(
            "SHIPMENT_PICKED_UP"
        );
        expect(shipmentStatusToEventKey("IN_TRANSIT")).toBe(
            "SHIPMENT_IN_TRANSIT"
        );
        expect(shipmentStatusToEventKey("DELIVERED")).toBe(
            "SHIPMENT_DELIVERED"
        );
        expect(shipmentStatusToEventKey("UNDELIVERED")).toBe(
            "SHIPMENT_UNDELIVERED"
        );
        expect(shipmentStatusToEventKey("RETURNED")).toBe(
            "SHIPMENT_RETURNED"
        );
        expect(shipmentStatusToEventKey("CANCELLED")).toBe(
            "SHIPMENT_CANCELLED"
        );
        expect(
            shipmentStatusToEventKey("WAITING_SHIPPING_PAYMENT")
        ).toBe("SHIPPING_PAYMENT_REQUIRED");
    });

    it("stays silent for transient lock / enqueue states", () => {
        expect(shipmentStatusToEventKey("SHIPMENT_PENDING")).toBeNull();
        expect(shipmentStatusToEventKey("CREATING")).toBeNull();
        expect(shipmentStatusToEventKey("PAYING")).toBeNull();
    });
});

describe("WhatsApp message content", () => {
    it("includes the resi and courier on a PICKED UP message", () => {
        const text = generateOrderStatusMessage(
            shipmentPayload()
        );

        expect(text).toContain("CN-777");
        expect(text).toContain("jne");
        expect(text).toContain("ORD-10");
        // Recipient phone is the authoritative destination.
        expect(text).toContain("081234567890");
    });

    it("uses the matching Bahasa label per status", () => {
        expect(
            generateOrderStatusMessage(
                shipmentPayload({
                    newStatus: "SHIPMENT_PICKED_UP",
                })
            )
        ).toContain("Paket Sudah Diambil Kurir");

        expect(
            generateOrderStatusMessage(
                shipmentPayload({
                    newStatus: "SHIPMENT_DELIVERED",
                })
            )
        ).toContain("Paket Sudah Diterima");
    });

    it("never leaks the Mengantar API key / webhook secret", () => {
        process.env.MENGANTAR_API_KEY = "SUPER_SECRET_API_KEY";
        process.env.MENGANTAR_WEBHOOK_SECRET = "SUPER_SECRET_WEBHOOK";

        const text = generateOrderStatusMessage(
            shipmentPayload()
        );

        expect(text).not.toContain("SUPER_SECRET_API_KEY");
        expect(text).not.toContain("SUPER_SECRET_WEBHOOK");
    });

    it("the message module never references provider credentials", () => {
        const message = readFileSync(
            "lib/whatsapp/message.ts",
            "utf-8"
        );
        const provider = readFileSync(
            "lib/notification/baileys-provider.ts",
            "utf-8"
        );

        for (const file of [message, provider]) {
            expect(file).not.toContain("MENGANTAR_API_KEY");
            expect(file).not.toContain(
                "MENGANTAR_WEBHOOK_SECRET"
            );
        }
    });
});

describe("NotificationService idempotency", () => {
    let service: NotificationService;

    beforeEach(() => {
        jest.clearAllMocks();

        prisma.notification.findUnique.mockResolvedValue(null);
        prisma.notification.create.mockResolvedValue({ id: 55 });
        prisma.notification.update.mockResolvedValue({});

        enqueue.mockReturnValue("job_1");

        service = new NotificationService({
            provider: new MockNotificationProvider(),
            channel: "whatsapp",
        });
    });

    async function handle(
        previous: string,
        next: string,
        orderId = 10
    ) {
        await service.handleOrderStatusChanged({
            orderId,
            orderNumber: "ORD-10",
            userId: "user-1",
            recipientPhone: "081234567890",
            previousStatus: previous,
            newStatus: next,
            total: 110000,
            items: [],
            trackingNumber: "CN-777",
            trackingUrl: null,
            shippingCourier: "jne",
            timestamp: new Date(),
        });
    }

    it("creates exactly one record for a transition", async () => {
        await handle("SHIPMENT_CREATED", "SHIPMENT_PICKED_UP");

        expect(prisma.notification.create).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledTimes(1);

        const created =
            prisma.notification.create.mock.calls[0][0];
        expect(created.data.idempotencyKey).toBe(
            "notif_order_10_SHIPMENT_CREATED_SHIPMENT_PICKED_UP"
        );
    });

    it("does not duplicate when the SAME transition is replayed", async () => {
        // First event creates the record; the replay finds it.
        prisma.notification.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: 55,
                status: "SENT",
            });

        await handle("SHIPMENT_CREATED", "SHIPMENT_PICKED_UP");
        await handle("SHIPMENT_CREATED", "SHIPMENT_PICKED_UP");

        expect(prisma.notification.create).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it("treats each distinct transition as its own notification", async () => {
        await handle("SHIPMENT_CREATED", "SHIPMENT_PICKED_UP");
        await handle("SHIPMENT_PICKED_UP", "SHIPMENT_IN_TRANSIT");
        await handle("SHIPMENT_IN_TRANSIT", "SHIPMENT_DELIVERED");

        expect(prisma.notification.create).toHaveBeenCalledTimes(3);
        expect(enqueue).toHaveBeenCalledTimes(3);
    });

    it("keeps order-status and shipment notifications in separate key spaces", async () => {
        await handle("PAID", "PROCESSING");

        const created =
            prisma.notification.create.mock.calls[0][0];
        expect(created.data.idempotencyKey).toContain(
            "notif_order_10_PAID_PROCESSING"
        );
    });
});
