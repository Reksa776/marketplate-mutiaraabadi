import { prisma } from "@/lib/prisma";
import {
    getMengantarLabelGeneration,
    requestMengantarLabelGeneration,
    toMengantarCourier,
} from "@/lib/mengantar";
import { getWhatsAppService } from "@/lib/whatsapp/service";
import { normalizePhone, normalizePhoneToJid, isValidIndonesianPhone } from "@/lib/whatsapp/phone";

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
 * Generate Mengantar's per-shipment label and send the PDF only to the
 * configured admin WhatsApp numbers. A Notification row
 * is the durable idempotency/claim record; its payload contains only
 * provider IDs and delivery markers, never the expiring URL or PDF bytes.
 */
export async function sendShipmentLabelToAdmins(orderId: number): Promise<void> {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            orderNumber: true,
            providerShipmentId: true,
            providerCourier: true,
            trackingNumber: true,
            shipmentStatus: true,
        },
    });

    if (
        !order ||
        !order.providerShipmentId ||
        !order.trackingNumber ||
        order.shipmentStatus === "DELETED"
    ) return;

    const setting = await prisma.storeSetting.findUnique({
        where: { id: 1 },
        select: { orderNotificationPhones: true },
    });
    const recipients = [...new Set((setting?.orderNotificationPhones ?? "")
        .split(/[\n,;]+/)
        .map((value) => normalizePhone(value.trim()))
        .filter((value): value is string => Boolean(value)))];
    if (!recipients.length) {
        console.warn(`[SHIPMENT LABEL] No valid admin WhatsApp numbers are configured for order ${order.id}`);
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
    const priorPayload = parsePayload(notification?.payload ?? null);
    const previouslySent = new Set(
        Array.isArray(priorPayload.sentRecipients)
            ? priorPayload.sentRecipients.filter((value): value is string => typeof value === "string")
            : notification?.status === "SENT"
              ? notification.recipient.split(/[\n,;]+/).map((value) => normalizePhone(value.trim())).filter((value): value is string => Boolean(value))
              : []
    );
    if (notification?.status === "SENT" && recipients.every((recipient) => previouslySent.has(recipient))) return;

    const staleBefore = new Date(Date.now() - 10 * 60_000);
    let ownsClaim = false;
    if (!notification) {
        try {
            notification = await prisma.notification.create({
                data: {
                    orderId: order.id,
                    channel: "whatsapp",
                    notificationType: "SHIPMENT_LABEL_PDF",
                    recipient: recipients.join(","),
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
    if (!notification) return;

    if (!ownsClaim) {
        const canClaim = notification.status === "FAILED" ||
            notification.status === "QUEUED" ||
            notification.status === "SENT" ||
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
                recipient: recipients.join(","),
                errorCode: null,
                errorMessage: null,
                retryCount: { increment: 1 },
            },
        });
        if (!claimed.count) return;
    }

    try {
        const payload = parsePayload(notification.payload);
        const sentRecipients = new Set(
            Array.isArray(payload.sentRecipients)
                ? payload.sentRecipients.filter((value): value is string => typeof value === "string")
                : previouslySent
        );
        let providerMessageId: string | null = null;
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
                data: { payload: JSON.stringify({ providerOrderId: order.providerShipmentId, labelGenerationId: generationId, sentRecipients: [...sentRecipients] }) },
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
        for (const recipient of recipients) {
            if (sentRecipients.has(recipient)) continue;
            const jid = normalizePhoneToJid(recipient);
            if (!jid || !isValidIndonesianPhone(recipient)) continue;
            const sendResult = await service.sendDocument(
                jid,
                pdf,
                `resi-${order.orderNumber}.pdf`,
                `Mutiara Abadi Snack — bukti label pengiriman pesanan ${order.orderNumber} (resi ${order.trackingNumber}). Notifikasi dari website Mutiara Abadi Snack.`
            );
            if (!sendResult.success) {
                throw new Error(sendResult.errorMessage || "WhatsApp menolak dokumen PDF.");
            }
            providerMessageId = sendResult.messageId ?? providerMessageId;
            sentRecipients.add(recipient);
            await prisma.notification.update({
                where: { id: notification.id },
                data: { payload: JSON.stringify({ providerOrderId: order.providerShipmentId, labelGenerationId: generationId, sentRecipients: [...sentRecipients] }) },
            });
        }

        const missingRecipients = recipients.filter((recipient) => !sentRecipients.has(recipient));
        if (missingRecipients.length) {
            throw new Error("PDF belum berhasil dikirim ke semua penerima WhatsApp.");
        }

        await prisma.notification.update({
            where: { id: notification.id },
            data: {
                status: "SENT",
                providerMessageId,
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
