/**
 * ==========================================
 * ORDER PAYMENT (iPaymu DIRECT)
 * ==========================================
 *
 * Server-side glue between a created order and the iPaymu direct
 * payment instruction.
 *
 * Responsibilities:
 *  - create the provider payment (server-authoritative amount,
 *    reference, buyer data, notifyUrl)
 *  - persist the sanitized instruction so OUR payment page can render
 *    it (and re-render it after a refresh) without ever letting the
 *    browser call iPaymu
 *  - expose a read model for the polling endpoint
 *  - settle an unused payment that reached the provider expiry by
 *    delegating to the existing checkout lifecycle
 *
 * SECURITY
 *  - the merchant VA / API key / signature are never persisted or
 *    returned to a client
 *  - only the client-safe instruction fields are selected in the view
 */

import { prisma } from "@/lib/prisma";
import { rollbackCheckoutOrder } from "@/lib/checkout";

import {
    buildPaymentInstruction,
    createDirectPayment,
    resolveProviderMethod,
    sanitizePaymentNo,
    type IpaymuDirectPaymentMethod,
    type PaymentInstruction,
} from "./ipaymu";

/* ==========================================
 * CONSTANTS
 * ========================================== */

/**
 * Grace period after the provider expiry before WE settle an unpaid
 * order as expired.
 *
 * The provider expiry is the authoritative cutoff, but a small grace
 * avoids racing a payment made right at the boundary (the bank/e-wallet
 * side of the transaction can complete a moment later). Nothing here
 * can mark an order PAID — it can only cancel an unused reservation.
 */
export const PAYMENT_EXPIRY_GRACE_MS = 5 * 60 * 1000;

export const PAYMENT_PAGE_BASE_PATH = "/checkout/payment";

/* ==========================================
 * CHANNEL LABELS (display only)
 * ========================================== */

const VA_CHANNEL_LABELS: Record<string, string> = {
    bag: "Bank Arta Graha (BAG)",
    bca: "BCA",
    bpd_bali: "BPD Bali",
    bni: "BNI",
    cimb: "CIMB Niaga",
    mandiri: "Mandiri",
    bmi: "Bank Muamalat",
    bri: "BRI",
    bsi: "BSI",
    permata: "Permata",
    danamon: "Danamon",
    btn: "BTN",
};

const EWALLET_CHANNEL_LABELS: Record<string, string> = {
    dana: "DANA",
    shopeepay: "ShopeePay",
    ovo: "OVO",
    gopay: "GoPay",
    linkaja: "LinkAja",
};

export function getChannelLabel(
    method: "BANK_TRANSFER" | "E_WALLET" | "QRIS" | "COD",
    channel: string | null
): string | null {
    if (!channel) return null;

    if (method === "BANK_TRANSFER") {
        return VA_CHANNEL_LABELS[channel] ?? channel.toUpperCase();
    }

    if (method === "E_WALLET") {
        return EWALLET_CHANNEL_LABELS[channel] ?? channel;
    }

    if (method === "QRIS") return "QRIS";

    return null;
}

/* ==========================================
 * CLIENT-SAFE READ MODEL
 * ========================================== */

export type PaymentInstructionKind =
    | "QRIS"
    | "VIRTUAL_ACCOUNT"
    | "EWALLET"
    | "COD"
    | "NONE";

export type PaymentView = {
    orderId: number;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    paymentMethod: "COD" | "BANK_TRANSFER" | "E_WALLET" | "QRIS";
    paymentChannel: string | null;
    /** Total charged for this order (server-authoritative). */
    amount: number;
    paidAt: string | null;
    createdAt: string;
    /** Provider expiry (absolute UTC instant), if the provider gave one. */
    expiresAt: string | null;
    /** True when the provider expiry (plus grace) has passed. */
    isExpired: boolean;
    /** Payment window still open AND order still awaiting payment. */
    canPay: boolean;
    instruction: {
        kind: PaymentInstructionKind;
        /** e.g. "BCA" / "DANA" / "QRIS" */
        channelLabel: string | null;
        /** VA number / payment code to pay to. */
        paymentNo: string | null;
        /** QR image URL (QRIS) — provider URL, http(s) only. */
        qrImageUrl: string | null;
        /**
         * Raw QRIS payload (QRIS only). Rendered into a QR by the page
         * when no image URL is servable. Never displayed as text.
         */
        qrString: string | null;
        /** E-wallet action URL — provider URL, http(s) only. */
        actionUrl: string | null;
        amount: number;
        expiresAt: string | null;
    };
};

export function getInstructionKind(
    paymentMethod: "COD" | "BANK_TRANSFER" | "E_WALLET" | "QRIS"
): PaymentInstructionKind {
    switch (paymentMethod) {
        case "BANK_TRANSFER":
            return "VIRTUAL_ACCOUNT";
        case "E_WALLET":
            return "EWALLET";
        case "QRIS":
            return "QRIS";
        case "COD":
            return "COD";
        default:
            return "NONE";
    }
}

/* ==========================================
 * PERSIST INSTRUCTION
 * ========================================== */

export async function savePaymentInstruction(
    orderId: number,
    instruction: PaymentInstruction
): Promise<void> {
    /*
     * Write-site guard: whatever the caller built, `paymentNo` must fit
     * the VARCHAR(191) column and must never be a URL/data-URI. Values
     * that fail the guard are dropped (never truncated) — the persisted
     * instruction keeps the separately-held `paymentUrl` intact.
     */
    const paymentNo = sanitizePaymentNo(instruction.paymentNo);

    await prisma.order.update({
        where: { id: orderId },
        data: {
            paymentNo,
            paymentUrl:
                instruction.qrImageUrl ?? instruction.paymentUrl ?? null,
            qrString: instruction.qrString ?? null,
            paymentChannel: instruction.channel || null,
            paymentExpiresAt: instruction.expiresAt ?? null,
        },
    });
}

/* ==========================================
 * CREATE DIRECT PAYMENT FOR AN ORDER
 * ========================================== */

export type CreateDirectOrderPaymentInput = {
    orderId: number;
    /** Our server-authoritative order number (provider referenceId). */
    orderNumber: string;
    buyerName: string;
    buyerPhone: string;
    buyerEmail: string;
    /** SERVER-AUTHORITATIVE amount — never a client value. */
    amount: number;
    paymentMethod: "BANK_TRANSFER" | "E_WALLET" | "QRIS";
    /** Customer-selected channel, validated against the allowlist. */
    paymentChannel?: string | null;
    /** SERVER-AUTHORITATIVE webhook URL. */
    notifyUrl: string;
    comments?: string;
};

export type CreateDirectOrderPaymentResult = {
    /** Internal payment page the customer is sent to (never iPaymu). */
    paymentPageUrl: string;
    instruction: PaymentInstruction;
    providerMethod: IpaymuDirectPaymentMethod;
    providerChannel: string;
    providerSessionId: string | null;
    providerTransactionId: string | null;
};

export function getPaymentPagePath(orderId: number): string {
    return `${PAYMENT_PAGE_BASE_PATH}/${orderId}`;
}

/* ==========================================
 * REUSE AN OPEN INSTRUCTION
 * ==========================================
 *
 * "Bayar Lagi" must NOT create a second provider payment for an
 * order that already has a live instruction: the provider keys the
 * transaction by `referenceId` (= our orderNumber), so a duplicate
 * attempt either gets rejected or makes settlement ambiguous.
 *
 * Reuse is therefore attempted first and only a missing, expired,
 * mismatched or unusable instruction causes a new provider payment.
 *
 * Only an order that is STILL awaiting payment is reusable — a
 * CANCELLED / FAILED / EXPIRED attempt must always get a fresh
 * instruction (its old one is dead).
 */

export type ReusableInstructionOrder = {
    status: string;
    paymentStatus: string;
    paymentMethod: "COD" | "BANK_TRANSFER" | "E_WALLET" | "QRIS";
    paymentNo: string | null;
    paymentUrl: string | null;
    qrString: string | null;
    paymentChannel: string | null;
    paymentExpiresAt: Date | null;
};

export function canReusePaymentInstruction(
    order: ReusableInstructionOrder,
    requestedMethod: "BANK_TRANSFER" | "E_WALLET" | "QRIS",
    now: Date = new Date()
): boolean {
    // Still awaiting payment — a cancelled/failed order needs a new
    // instruction (its provider payment is dead or was released).
    if (order.status !== "PENDING" || order.paymentStatus !== "PENDING") {
        return false;
    }

    // The page renders the instruction according to the method, so a
    // method change (or a legacy value) always needs a new payment.
    if (order.paymentMethod !== requestedMethod) return false;

    // Without a provider expiry we cannot prove the window is open.
    if (!order.paymentExpiresAt) return false;

    // Same grace as expiry settlement: while the provider window (plus
    // grace) is open, the existing instruction is still payable.
    if (
        order.paymentExpiresAt.getTime() + PAYMENT_EXPIRY_GRACE_MS <=
        now.getTime()
    ) {
        return false;
    }

    // Something the customer can actually act on.
    if (requestedMethod === "BANK_TRANSFER") {
        return Boolean(order.paymentNo);
    }

    // QRIS pays through a QR image URL or, failing that, the raw
    // payload rendered into a QR. A QRIS `paymentNo` is never a usable
    // instruction (it is always null after the mapping fix).
    if (requestedMethod === "QRIS") {
        return Boolean(order.paymentUrl || order.qrString);
    }

    return Boolean(order.paymentUrl || order.paymentNo);
}

export async function createDirectOrderPayment(
    input: CreateDirectOrderPaymentInput
): Promise<CreateDirectOrderPaymentResult> {
    // Validate the requested channel before we touch the provider.
    const { method, channel } = resolveProviderMethod(
        input.paymentMethod,
        input.paymentChannel
    );

    const response = await createDirectPayment({
        name: input.buyerName,
        phone: input.buyerPhone,
        email: input.buyerEmail,
        amount: input.amount,
        notifyUrl: input.notifyUrl,
        referenceId: input.orderNumber,
        paymentMethod: method,
        paymentChannel: channel,
        comments: input.comments,
    });

    const instruction = buildPaymentInstruction(
        response.Data,
        input.paymentMethod
    );

    if (!instruction) {
        throw new Error(
            "[IPAYMU_API_ERROR] iPaymu tidak mengembalikan data pembayaran yang dapat ditampilkan."
        );
    }

    await savePaymentInstruction(input.orderId, instruction);

    return {
        paymentPageUrl: getPaymentPagePath(input.orderId),
        instruction,
        providerMethod: method,
        providerChannel: channel,
        providerSessionId: response.Data?.SessionId ?? null,
        providerTransactionId:
            response.Data?.TransactionId !== undefined
                ? String(response.Data.TransactionId)
                : null,
    };
}

/* ==========================================
 * READ MODEL (polling)
 * ========================================== */

/**
 * Load the payment view for a single order owned by `userId`.
 *
 * Returns null when the order does not exist OR is not owned by the
 * caller — callers must answer 404 for both cases so order existence
 * is not leaked.
 */
export async function loadPaymentView(
    orderId: number,
    userId: string
): Promise<PaymentView | null> {
    const order = await prisma.order.findFirst({
        where: { id: orderId, userId },
        select: {
            id: true,
            orderNumber: true,
            status: true,
            paymentStatus: true,
            paymentMethod: true,
            paymentChannel: true,
            paymentNo: true,
            paymentUrl: true,
            qrString: true,
            paymentExpiresAt: true,
            total: true,
            paidAt: true,
            createdAt: true,
        },
    });

    if (!order) return null;

    const amount = Number(order.total);
    const expiresAt = order.paymentExpiresAt ?? null;
    const isExpired = expiresAt
        ? expiresAt.getTime() + PAYMENT_EXPIRY_GRACE_MS <= Date.now()
        : false;

    const canPay =
        order.status === "PENDING" &&
        order.paymentStatus === "PENDING" &&
        !isExpired;

    const qrImageUrl =
        order.paymentMethod === "QRIS" ? order.paymentUrl : null;

    const qrString =
        order.paymentMethod === "QRIS" ? order.qrString : null;

    const actionUrl =
        order.paymentMethod === "E_WALLET" ? order.paymentUrl : null;

    return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        paymentChannel: order.paymentChannel,
        amount,
        paidAt: order.paidAt ? order.paidAt.toISOString() : null,
        createdAt: order.createdAt.toISOString(),
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        isExpired,
        canPay,
        instruction: {
            kind: getInstructionKind(order.paymentMethod),
            channelLabel: getChannelLabel(
                order.paymentMethod,
                order.paymentChannel
            ),
            paymentNo: order.paymentNo,
            qrImageUrl,
            qrString,
            actionUrl,
            amount,
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
        },
    };
}

/* ==========================================
 * PROVIDER EXPIRY SETTLEMENT
 * ==========================================
 *
 * When the provider payment window closes unused, the reservation
 * must be released. This delegates to rollbackCheckoutOrder(), the
 * existing lifecycle function (atomic CAS + stock/voucher/shipping
 * discount/spin wheel release + affiliate commission cancellation),
 * so rollback logic is never duplicated.
 *
 * Guarantees:
 *  - only fires when the provider expiry (plus grace) has passed
 *  - only for orders still awaiting payment (PENDING/PENDING)
 *  - CAS inside rollbackCheckoutOrder makes concurrent calls (webhook,
 *    cleanup, customer) idempotent — a PAID order can never be
 *    cancelled by this path.
 */

export type ExpirySettlementResult =
    | "EXPIRED"
    | "NOT_EXPIRED"
    | "NOT_FOUND"
    | "NOT_CANCELLABLE";

export async function expireUnpaidOrderIfExpired(
    orderId: number,
    userId: string,
    now: Date = new Date()
): Promise<ExpirySettlementResult> {
    const order = await prisma.order.findFirst({
        where: { id: orderId, userId },
        select: {
            id: true,
            status: true,
            paymentStatus: true,
            paymentExpiresAt: true,
        },
    });

    // Not owned / does not exist → indistinguishable to the caller.
    if (!order) return "NOT_FOUND";

    if (
        order.status !== "PENDING" ||
        order.paymentStatus !== "PENDING"
    ) {
        return "NOT_CANCELLABLE";
    }

    const expiresAt = order.paymentExpiresAt;

    // No provider expiry recorded → never guess. The webhook expired
    // event and the checkout cleanup remain the authorities.
    if (!expiresAt) return "NOT_EXPIRED";

    if (expiresAt.getTime() + PAYMENT_EXPIRY_GRACE_MS > now.getTime()) {
        return "NOT_EXPIRED";
    }

    await rollbackCheckoutOrder(orderId, { restoreCart: false });

    return "EXPIRED";
}
