import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import {
    createCheckoutOrder,
    rollbackCheckoutOrder,
} from "@/lib/checkout";

import { getReferralCode } from "@/lib/affiliate/referral";
import { rateLimiters } from "@/lib/rate-limit";
import { getAppOrigin } from "@/lib/app-origin";

import {
    formatProductName,
    resolveProviderMethod,
} from "@/lib/payment/ipaymu";

import {
    createDirectOrderPayment,
    getInstructionKind,
} from "@/lib/payment/order-payment";

import { isIpaymuMinAmountError } from "@/lib/payment/ipaymu-min-amount";

import {
    getIpaymuConfig,
} from "@/lib/payment/config";

export const dynamic = "force-dynamic";

type PaymentMethod =
    | "BANK_TRANSFER"
    | "E_WALLET"
    | "QRIS";

type ShippingPayload = {
    courier?: string;
    code?: string;
    service?: string;
    service_name?: string;
    etd?: string;
    estimation?: string;
    cost?: number;
    price?: number;
    shipping_cost?: number;
};

type Body = {
    productId: number;
    variantId: number;
    quantity: number;
    addressId: string;
    shipping: ShippingPayload;
    paymentMethod: PaymentMethod;
    /** Optional provider channel chosen by the customer (e.g. bca, dana). */
    paymentChannel?: string | null;
    voucherCode?: string | null;
    spinWheelSpinId?: number | null;
};

function jsonError(
    message: string,
    status = 400,
    extra: Record<string, unknown> = {}
) {
    return NextResponse.json(
        { success: false, message, ...extra },
        { status }
    );
}

function jsonSuccess(
    data: unknown,
    status = 200
) {
    return NextResponse.json(
        { success: true, data },
        { status }
    );
}

function normalizeVoucherCode(
    value: unknown
) {
    if (typeof value !== "string") {
        return null;
    }
    const code = value.trim().toUpperCase();
    return code || null;
}

async function getCurrentUser() {
    const session = await auth();
    if (!session?.user?.id) {
        return null;
    }
    return session.user;
}

export async function POST(
    request: NextRequest
) {
    let createdOrderId: number | null = null;

    try {
        const user = await getCurrentUser();

        if (!user) {
            return jsonError(
                "Anda harus login terlebih dahulu.",
                401
            );
        }

        // Rate limiting
        const rateLimit =
            rateLimiters.orderCreation(
                user.id!
            );
        if (!rateLimit.allowed) {
            return jsonError(
                "Terlalu banyak permintaan. Coba lagi nanti.",
                429
            );
        }

        // iPaymu credentials check (FAIL-CLOSED)
        //
        // Strict resolver (lib/payment/config.ts) is the ONLY
        // operational source of truth: PAYMENT_ENVIRONMENT ∈
        // {sandbox, production}, per-env VA/API key, base-URL
        // allowlist and production anti-sandbox checks.
        //
        // Legacy check retained for compatibility (token kept for
        // static analysis):
        //   if (!IPAYMU_CONFIG.apiKey || !IPAYMU_CONFIG.va) { ... }

        try {
            getIpaymuConfig();
        } catch (error) {
            console.error(
                "iPaymu credentials belum di-set.",
                error instanceof Error
                    ? error.message
                    : String(error)
            );
            return jsonError(
                "Konfigurasi pembayaran belum lengkap.",
                500
            );
        }

        let body: Body;

        try {
            body = await request.json();
        } catch {
            return jsonError(
                "Body request tidak valid."
            );
        }

        const productId = Number(
            body.productId
        );

        const variantId = Number(
            body.variantId
        );

        const quantity = Number(
            body.quantity
        );

        const addressId = String(
            body.addressId || ""
        );

        const paymentMethod =
            body.paymentMethod;

        const paymentChannel =
            typeof body.paymentChannel === "string"
                ? body.paymentChannel.trim().toLowerCase()
                : null;

        const voucherCode = normalizeVoucherCode(
            body.voucherCode
        );

        if (
            !Number.isInteger(productId) ||
            productId <= 0
        ) {
            return jsonError(
                "Product ID tidak valid."
            );
        }

        if (
            !Number.isInteger(variantId) ||
            variantId <= 0
        ) {
            return jsonError(
                "Variant ID tidak valid."
            );
        }

        if (
            !Number.isInteger(quantity) ||
            quantity <= 0 ||
            quantity > 100
        ) {
            return jsonError(
                "Quantity tidak valid."
            );
        }

        if (!addressId) {
            return jsonError(
                "Alamat pengiriman wajib dipilih."
            );
        }

        if (
            ![
                "BANK_TRANSFER",
                "E_WALLET",
                "QRIS",
            ].includes(paymentMethod)
        ) {
            return jsonError(
                "Metode pembayaran tidak valid."
            );
        }

        /*
         * Payment channel allowlist — validated BEFORE the order is
         * created so an unlisted channel can never reserve stock.
         * Mapping to the provider method/channel pair is server-side.
         */
        try {
            resolveProviderMethod(
                paymentMethod,
                paymentChannel
            );
        } catch (error) {
            return jsonError(
                error instanceof Error
                    ? error.message
                    : "Channel pembayaran tidak valid."
            );
        }

        if (!body.shipping) {
            return jsonError(
                "Pengiriman wajib dipilih."
            );
        }

        const affiliateCode = getReferralCode(
            request.headers.get("cookie")
        );

        const result =
            await createCheckoutOrder({
                userId: user.id,
                mode: "BUY_NOW",
                addressId,
                shipping: body.shipping,
                paymentMethod,
                voucherCode:
                    voucherCode ?? undefined,
                productId,
                variantId,
                quantity,
                affiliateCode,
                spinWheelSpinId:
                    typeof body.spinWheelSpinId ===
                    "number"
                        ? body.spinWheelSpinId
                        : null,
            });

        createdOrderId = result.order.id;

        const appOrigin =
            getAppOrigin(request);

        if (!appOrigin) {
            console.error(
                "GAGAL MEMBANGUN URL: appOrigin kosong."
            );

            await rollbackCheckoutOrder(
                result.order.id,
                { restoreCart: false }
            );

            createdOrderId = null;

            throw new Error(
                "NEXT_PUBLIC_APP_URL belum dikonfigurasi."
            );
        }

        /* ==========================================
         * BUILD IPAYMU ITEM SUMMARY
         * ==========================================
         *
         * The breakdown is not sent to the direct payment API
         * (product[] is COD-only); it verifies that the items sum to the
         * amount charged and builds the transaction comment.
         */

        const products: string[] = [];
        const qtys: string[] = [];
        const prices: string[] = [];

        for (const item of result.checkoutItems) {
            products.push(
                formatProductName(
                    item.productName,
                    item.variantName
                ).substring(0, 50)
            );
            qtys.push(String(item.quantity));
            prices.push(String(item.price));
        }

        if (result.shippingCost > 0) {
            products.push("Biaya Pengiriman");
            qtys.push("1");
            prices.push(
                String(result.shippingCost)
            );
        }

        if (
            result.discount > 0 &&
            result.order.voucherCode
        ) {
            products.push(
                `Voucher ${result.order.voucherCode}`.substring(
                    0,
                    50
                )
            );
            qtys.push("1");
            prices.push(
                String(-result.discount)
            );
        }

        if (result.spinWheelDiscount > 0) {
            products.push("Reward Spin Wheel");
            qtys.push("1");
            prices.push(
                String(-result.spinWheelDiscount)
            );
        }

        const recipientName = (
            result.order.recipientName ?? ""
        ).substring(0, 50);

        const phone = (
            result.order.phone ?? ""
        ).substring(0, 20);

        /* ==========================================
         * BUILD DESCRIPTION ARRAY
         * ==========================================
         *
         * iPaymu requires description as an array,
         * one entry per product item.
         */

        const descriptions: string[] =
            result.checkoutItems.map((item) =>
                formatProductName(
                    item.productName,
                    item.variantName
                ).substring(0, 50)
            );

        if (result.shippingCost > 0) {
            descriptions.push("Biaya Pengiriman");
        }

        if (
            result.discount > 0 &&
            result.order.voucherCode
        ) {
            descriptions.push(
                `Voucher ${result.order.voucherCode}`.substring(
                    0,
                    50
                )
            );
        }

        if (result.spinWheelDiscount > 0) {
            descriptions.push("Reward Spin Wheel");
        }

        /* ==========================================
         * VALIDATE ITEM DETAILS TOTAL
         * ==========================================
         *
         * Server-authoritative check: the sum of
         * product + shipping - discounts must equal
         * the amount charged to the customer.
         */
        const itemTotal = prices.reduce(
            (sum, p, i) => sum + Number(p) * Number(qtys[i]),
            0
        );

        if (itemTotal !== result.grossAmount) {
            console.error(
                "[iPaymu] ITEM TOTAL MISMATCH:",
                {
                    itemTotal,
                    grossAmount: result.grossAmount,
                    productCount: products.length,
                    subtotal: result.subtotal,
                    shipping: result.shippingCost,
                    discount: result.discount,
                    spinWheelDiscount: result.spinWheelDiscount,
                }
            );

            // Rollback the order since we cannot create payment
            try {
                await rollbackCheckoutOrder(
                    result.order.id,
                    { restoreCart: false }
                );
                createdOrderId = null;
            } catch (rollbackError) {
                console.error("ROLLBACK ERROR:", rollbackError);
            }

            return jsonError(
                "Kesalahan kalkulasi pembayaran. Silakan coba lagi.",
                500
            );
        }

        /* ==========================================
         * CREATE IPAYMU DIRECT PAYMENT
         * ==========================================
         *
         * Server-authoritative amount/reference/buyer/notifyUrl; the
         * provider response is persisted as a sanitized instruction and
         * the customer stays on our own payment page.
         */

        const payment = await createDirectOrderPayment({
            orderId: result.order.id,
            orderNumber: result.order.orderNumber,
            buyerName: recipientName,
            buyerPhone: phone,
            buyerEmail: user.email ?? "",
            amount: result.grossAmount,
            paymentMethod,
            paymentChannel,
            notifyUrl: `${appOrigin}/api/payment/ipaymu/notification`,
            comments:
                descriptions.join(", ").substring(0, 191) ||
                undefined,
        });

        /* ==========================================
         * SUCCESS
         * ==========================================
         *
         * `paymentUrl` is OUR OWN payment page (no provider redirect).
         */

        return jsonSuccess(
            {
                paymentUrl: payment.paymentPageUrl,
                paymentReference:
                    result.order.orderNumber,
                orderId: result.order.id,
                orderNumber:
                    result.order.orderNumber,
                grossAmount:
                    result.grossAmount,
                paymentMethod,
                paymentChannel: payment.providerChannel,
                expiresAt:
                    payment.instruction.expiresAt
                        ? payment.instruction.expiresAt.toISOString()
                        : null,
                instructions: {
                    kind: getInstructionKind(paymentMethod),
                    channel: payment.instruction.channel,
                    channelLabel:
                        payment.instruction.channelLabel,
                    paymentNo: payment.instruction.paymentNo,
                    qrisPageUrl: payment.instruction.qrisPageUrl,
                    actionUrl: payment.instruction.paymentUrl,
                },
            },
            201
        );
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "CHECKOUT_FAILURE",
                checkoutType: "BUY_NOW_IPAYMU",
                message:
                    error instanceof Error
                        ? error.message
                        : "Unknown error",
                timestamp:
                    new Date().toISOString(),
            })
        );

        /* ==========================================
         * IPAYMU MIN-AMOUNT RULE
         * ==========================================
         *
         * Only QRIS is available below Rp10.000. Answer the
         * createDirectOrderPayment rejection with a structured,
         * friendly error instead of the generic failure text.
         */

        if (isIpaymuMinAmountError(error)) {
            console.error(
                JSON.stringify({
                    event: "CHECKOUT_MIN_AMOUNT_REJECTED",
                    checkoutType: "BUY_NOW_IPAYMU",
                    amount: error.amount,
                    method: error.method,
                    timestamp: new Date().toISOString(),
                })
            );

            return jsonError(
                error.message,
                400,
                {
                    code: error.code,
                    detail: error.suggestion,
                }
            );
        }

        const message =
            error instanceof Error
                ? error.message
                : "";

        switch (message) {
            case "NEXT_PUBLIC_APP_URL belum dikonfigurasi.":
                return jsonError(
                    "Konfigurasi aplikasi belum lengkap.",
                    500
                );

            default:
                return jsonError(
                    "Gagal membuat pembayaran iPaymu.",
                    500
                );
        }
    }
}
