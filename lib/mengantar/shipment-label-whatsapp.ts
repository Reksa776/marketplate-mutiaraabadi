import { prisma } from "@/lib/prisma";
import {
    getMengantarLabelGeneration,
    requestMengantarLabelGeneration,
    toMengantarCourier,
} from "@/lib/mengantar";
import { getWhatsAppService } from "@/lib/whatsapp/service";
import { normalizePhoneToJid, isValidIndonesianPhone } from "@/lib/whatsapp/phone";

const LABEL_FORMAT = process.env.MENGANTAR_LABEL_FORMAT || "normal-1";
const LABEL_POLL_INTERVAL_MS = 2_000;
const LABEL_POLL_TIMEOUT_MS = 60_000;
const MAX_LABEL_BYTES = 15 * 1024 * 1024;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePayload(value: string | null): Record<string, unknown> {
    if (!value) return {};
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

async function downloadPdf(urlValue: string): Promise<Uint8Array> {
    const url = new URL(urlValue);
    if (url.protocol !== "https:" || url.hostname !== "storage.googleapis.com") {
        throw new Error("Link unduhan label Mengantar tidak valid.");
    }

    const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
        throw new Error(`PDF label gagal diunduh (HTTP ${response.status}).`);
    }
    const contentType = response.headers.get("content-type") || "";
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_LABEL_BYTES) {
        throw new Error("Ukuran PDF label melebihi batas 15 MB.");
    }
    if (contentType && !contentType.toLowerCase().includes("application/pdf")) {
        throw new Error("File dari Mengantar bukan PDF.");
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_LABEL_BYTES) {
        throw new Error("Ukuran PDF label melebihi batas 15 MB.");
    }
    if (bytes.byteLength < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
        throw new Error("File dari Mengantar bukan PDF yang valid.");
    }
    return bytes;
}

/**
 * Generate Mengantar's per-shipment label and send the PDF to the
 * customer. A Notification row is the durable idempotency/claim record;
 * its payload contains only provider IDs, never the expiring signed URL
 * or PDF bytes.
 */
export async function sendShipmentLabelToCustomer(orderId: number): Promise<void> {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            orderNumber: true,
            phone: true,
            providerShipmentId: true,
            providerCourier: true,
            trackingNumber: true,
            shipmentStatus: true,
            shippingPaymentStatus: true,
        },
    });

    if (
        !order ||
        !order.providerShipmentId ||
        !order.trackingNumber ||
        !["SHIPPING_PAID", "CREATED", "PICKED_UP", "IN_TRANSIT", "DELIVERED", "UNDELIVERED", "RETURNED", "CANCELLED"].includes(order.shipmentStatus || "") ||
        order.shippingPaymentStatus === "UNPAID"
    ) return;

    const recipient = String(order.phone || "").trim();
    if (!isValidIndonesianPhone(recipient)) {
        console.warn(`[SHIPMENT LABEL] Invalid WhatsApp number for order ${order.id}`);
        return;
    }
    const courier = toMengantarCourier(order.providerCourier);
    if (!courier) {
        console.warn(`[SHIPMENT LABEL] Unsupported courier for order ${order.id}`);
        return;
    }

    const service = getWhatsAppService();
    if (!service.isConnected()) {
        console.warn(`[SHIPMENT LABEL] WhatsApp is not connected for order ${order.id}`);
        return;
    }

    const idempotencyKey = `shipment-label-pdf:${order.id}`;
    let notification = await prisma.notification.findUnique({
        where: { idempotencyKey },
    });
    if (notification?.status === "SENT") return;

    const staleBefore = new Date(Date.now() - 10 * 60_000);
    let ownsClaim = false;
    if (!notification) {
        try {
            notification = await prisma.notification.create({
                data: {
                    orderId: order.id,
                    channel: "whatsapp",
                    notificationType: "SHIPMENT_LABEL_PDF",
                    recipient,
                    idempotencyKey,
                    status: "PROCESSING",
                    payload: JSON.stringify({ providerOrderId: order.providerShipmentId }),
                },
            });
            ownsClaim = true;
        } catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
            notification = await prisma.notification.findUnique({ where: { idempotencyKey } });
        }
    }
    if (!notification || notification.status === "SENT") return;

    if (!ownsClaim) {
        const canClaim = notification.status === "FAILED" ||
            notification.status === "QUEUED" ||
            (notification.status === "PROCESSING" && notification.updatedAt < staleBefore);
        if (!canClaim) return;

        const claimed = await prisma.notification.updateMany({
            where: {
                id: notification.id,
                status: notification.status,
                updatedAt: notification.updatedAt,
            },
            data: {
                status: "PROCESSING",
                recipient,
                errorCode: null,
                errorMessage: null,
                retryCount: { increment: 1 },
            },
        });
        if (!claimed.count) return;
    }

    try {
        const payload = parsePayload(notification.payload);
        let generationId = typeof payload.labelGenerationId === "string"
            ? payload.labelGenerationId
            : null;
        if (!generationId) {
            const job = await requestMengantarLabelGeneration({
                orderId: order.providerShipmentId,
                courier,
                format: LABEL_FORMAT,
            });
            generationId = job.labelGenerationId;
            await prisma.notification.update({
                where: { id: notification.id },
                data: { payload: JSON.stringify({ providerOrderId: order.providerShipmentId, labelGenerationId: generationId }) },
            });
        }

        const deadline = Date.now() + LABEL_POLL_TIMEOUT_MS;
        let completedUrl: string | null = null;
        while (Date.now() < deadline) {
            const job = await getMengantarLabelGeneration(generationId);
            if (job.status === "COMPLETED" && job.downloadUrl) {
                completedUrl = job.downloadUrl;
                break;
            }
            if (job.status === "FAILED") {
                throw new Error(job.errorMessage || "Mengantar gagal membuat PDF label.");
            }
            await sleep(LABEL_POLL_INTERVAL_MS);
        }
        if (!completedUrl) throw new Error("Pembuatan PDF label Mengantar belum selesai; silakan coba lagi.");

        // Download immediately: Mengantar's signed URL expires 15 minutes
        // after each completed status response.
        const pdf = await downloadPdf(completedUrl);
        const jid = normalizePhoneToJid(recipient);
        if (!jid) throw new Error("Nomor WhatsApp pelanggan tidak valid.");
        const sendResult = await service.sendDocument(
            jid,
            pdf,
            `resi-${order.orderNumber}.pdf`,
            `Label pengiriman pesanan ${order.orderNumber} (${order.trackingNumber}).`
        );
        if (!sendResult.success) throw new Error(sendResult.errorMessage || "Gagal mengirim PDF ke WhatsApp.");

        await prisma.notification.update({
            where: { id: notification.id },
            data: {
                status: "SENT",
                providerMessageId: sendResult.messageId,
                errorCode: null,
                errorMessage: null,
            },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Gagal mengirim PDF label.";
        await prisma.notification.update({
            where: { id: notification.id },
            data: {
                status: "FAILED",
                errorCode: "SHIPMENT_LABEL_FAILED",
                errorMessage: message.slice(0, 1000),
            },
        });
        console.error(`[SHIPMENT LABEL] Order ${order.id}: ${message}`);
    }
}
