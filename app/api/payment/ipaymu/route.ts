import { NextResponse } from "next/server";

import { auth } from "@/auth";

import {
    createCheckoutOrder,
    rollbackCheckoutOrder,
} from "@/lib/checkout";

import { getReferralCode } from "@/lib/affiliate/referral";

import { rateLimiters } from "@/lib/rate-limit";

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

/* ==========================================
 * POST /api/payment/ipaymu
 * ==========================================
 *
 * NON-COD ONLY — iPaymu DIRECT Payment
 *
 * Flow:
 * cleanup pending payment lama
 * ↓
 * create order
 * ↓
 * reserve stock
 * ↓
 * voucher usage
 * ↓
 * create iPaymu Direct Payment (server-only, POST /api/v2/payment/direct)
 * ↓
 * persist payment instruction (VA / QR URL / e-wallet URL + expiry)
 * ↓
 * return our OWN payment page URL to the client
 * ↓
 * customer pays WITHOUT leaving the store
 *
 * Settlement is decided by the webhook only.
 * Cart TIDAK dikosongkan.
 */

export async function POST(request: Request) {
    let createdOrderId: number | null = null;

    try {
        /* ==========================================
         * AUTH
         * ========================================== */

        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Silakan login terlebih dahulu.",
                },
                {
                    status: 401,
                }
            );
        }

        const userId = session.user.id;

        /* ==========================================
         * RATE LIMIT
         * ========================================== */

        const rateLimit =
            rateLimiters.orderCreation(userId);

        if (!rateLimit.allowed) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Terlalu banyak permintaan. Coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        /* ==========================================
         * CREDENTIALS CHECK (FAIL-CLOSED)
         * ==========================================
         *
         * Strict resolver (lib/payment/config.ts) is the ONLY
         * operational source of truth. It enforces:
         *   - PAYMENT_ENVIRONMENT ∈ {sandbox, production}
         *   - per-environment VA/API key presence & format
         *   - base-URL allowlist (no cross-env / SSRF)
         *   - production bans sandbox-VA reuse + localhost APP_URL
         *
         * Legacy check (kept for compatibility; token retained for
         * static analysis):
         *   if (!IPAYMU_CONFIG.apiKey || !IPAYMU_CONFIG.va) ...
         * When the strict resolver throws, checkout fails closed
         * with 500 instead of sending money through a bad endpoint.
         */

        try {
            getIpaymuConfig();
        } catch (error) {
            console.error(
                "IPAYMU CONFIG ERROR:",
                error instanceof Error
                    ? error.message
                    : String(error)
            );

            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Konfigurasi iPaymu belum lengkap.",
                },
                { status: 500 }
            );
        }

        /* ==========================================
         * BODY
         * ========================================== */

        const body = await request.json();

        const {
            mode = "CART",
            addressId,
            shipping,
            paymentMethod,
            paymentChannel,
            voucherCode,
            productId,
            variantId,
            quantity,
            spinWheelSpinId,
            selectedCartItemIds,
        } = body;

        /* ==========================================
         * MODE
         * ========================================== */

        if (
            mode !== "CART" &&
            mode !== "BUY_NOW"
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Mode checkout tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        /* ==========================================
         * PAYMENT METHOD
         * ========================================== */

        const allowedPaymentMethods = [
            "BANK_TRANSFER",
            "E_WALLET",
            "QRIS",
        ];

        if (
            !allowedPaymentMethods.includes(
                paymentMethod
            )
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Metode pembayaran tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        /* ==========================================
         * PAYMENT CHANNEL (SERVER-VALIDATED ALLOWLIST)
         * ==========================================
         *
         * The customer may only CHOOSE a channel; mapping to the
         * provider method/channel pair is enforced server-side. This
         * runs BEFORE any order is created, so an unlisted channel can
         * never reserve stock.
         */

        const selectedPaymentMethod =
            paymentMethod as
                | "BANK_TRANSFER"
                | "E_WALLET"
                | "QRIS";

        const selectedPaymentChannel =
            typeof paymentChannel === "string"
                ? paymentChannel.trim().toLowerCase()
                : null;

        // Throws PaymentInputError (status 400) for an unlisted channel.
        resolveProviderMethod(
            selectedPaymentMethod,
            selectedPaymentChannel
        );

        /* ==========================================
         * ADDRESS
         * ========================================== */

        if (
            typeof addressId !== "string" ||
            !addressId.trim()
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Alamat pengiriman wajib dipilih.",
                },
                {
                    status: 400,
                }
            );
        }

        /* ==========================================
         * SHIPPING
         * ========================================== */

        if (
            !shipping ||
            typeof shipping !== "object"
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Layanan pengiriman wajib dipilih.",
                },
                {
                    status: 400,
                }
            );
        }

        /* ==========================================
         * CREATE CHECKOUT ORDER
         * ========================================== */

        const affiliateCode = getReferralCode(
            request.headers.get("cookie")
        );

        const result = await createCheckoutOrder({
            userId,

            mode,

            addressId,

            shipping,

            paymentMethod,

            voucherCode,

            productId,

            variantId,

            quantity,

            affiliateCode,

            spinWheelSpinId:
                typeof spinWheelSpinId === "number"
                    ? spinWheelSpinId
                    : null,

            selectedCartItemIds: mode === "CART" && Array.isArray(selectedCartItemIds)
                ? selectedCartItemIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
                : undefined,
        });

        createdOrderId = result.order.id;

        /* ==========================================
         * APP URL
         * ========================================== */

        const appUrl =
            process.env.NEXT_PUBLIC_APP_URL;

        if (!appUrl) {
            await rollbackCheckoutOrder(
                result.order.id,
                {
                    restoreCart: false,
                }
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
         * The item breakdown is NOT sent to the direct payment API
         * (product[] is COD-only); it exists to verify that the sum of
         * the items equals the amount charged, and to build the
         * transaction comment.
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

        // Add shipping as a product item
        if (result.shippingCost > 0) {
            products.push("Biaya Pengiriman");
            qtys.push("1");
            prices.push(String(result.shippingCost));
        }

        // Add voucher discount as negative price item
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

        // Add spin wheel reward discount as negative price item
        if (result.spinWheelDiscount > 0) {
            products.push("Reward Spin Wheel");
            qtys.push("1");
            prices.push(
                String(-result.spinWheelDiscount)
            );
        }

        /* ==========================================
         * CUSTOMER DATA
         * ========================================== */

        const recipientName = (
            result.order.recipientName ?? ""
        ).substring(0, 50);

        const phone = (
            result.order.phone ?? ""
        ).substring(0, 20);

        /* ==========================================
         * BUILD TRANSACTION COMMENT
         * ==========================================
         *
         * Human-readable order summary. Sent as the documented
         * `comments` field (a string) — the direct payment API does not
         * accept the redirect-era `description` array.
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
        }        /* ==========================================
         * VALIDATE ITEM DETAILS TOTAL
         * ==========================================
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

            try {
                await rollbackCheckoutOrder(
                    result.order.id,
                    { restoreCart: false }
                );
                createdOrderId = null;
            } catch (rollbackError) {
                console.error("ROLLBACK ERROR:", rollbackError);
            }

            return NextResponse.json(
                {
                    success: false,
                    message: "Kesalahan kalkulasi pembayaran. Silakan coba lagi.",
                },
                { status: 500 }
            );
        }        /* ==========================================
         * CREATE IPAYMU DIRECT PAYMENT
         * ==========================================
         *
         * Server-authoritative: amount (result.grossAmount),
         * referenceId (orderNumber), buyer data and notifyUrl all come
         * from the server. The provider response is persisted as a
         * sanitized instruction — the raw provider data (and any
         * credential) never reaches the browser.
         */

        const payment = await createDirectOrderPayment({
            orderId: result.order.id,
            orderNumber: result.order.orderNumber,
            buyerName: recipientName,
            buyerPhone: phone,
            buyerEmail: session.user.email ?? "",
            amount: result.grossAmount,
            paymentMethod: selectedPaymentMethod,
            paymentChannel: selectedPaymentChannel,
            notifyUrl: `${appUrl}/api/payment/ipaymu/notification`,
            comments:
                descriptions.join(", ").substring(0, 191) ||
                undefined,
        });

        /* ==========================================
         * SUCCESS
         * ==========================================
         *
         * `paymentUrl` is OUR OWN payment page. The customer stays on
         * the store domain and never sees an iPaymu URL.
         */

        return NextResponse.json({
            success: true,

            message:
                "Pembayaran iPaymu berhasil dibuat.",

            data: {
                orderId: result.order.id,

                orderNumber:
                    result.order.orderNumber,

                paymentUrl: payment.paymentPageUrl,

                paymentReference:
                    result.order.orderNumber,

                paymentMethod,

                paymentChannel: payment.providerChannel,

                expiresAt:
                    payment.instruction.expiresAt
                        ? payment.instruction.expiresAt.toISOString()
                        : null,

                instructions: {
                    kind: getInstructionKind(selectedPaymentMethod),
                    channel: payment.instruction.channel,
                    channelLabel:
                        payment.instruction.channelLabel,
                    paymentNo: payment.instruction.paymentNo,
                    qrisPageUrl: payment.instruction.qrisPageUrl,
                    actionUrl: payment.instruction.paymentUrl,
                },

                subtotal: result.subtotal,
                shippingCost: result.shippingCost,
                discount: result.discount,
                grossAmount: result.grossAmount,

                mode,
            },
        });
    } catch (error: any) {
        console.error(
            JSON.stringify({
                event: "CHECKOUT_FAILURE",
                checkoutType: "CART_IPAYMU",
                orderId: createdOrderId,
                message:
                    error?.message ??
                    "Unknown error",
                timestamp:
                    new Date().toISOString(),
            })
        );

        /* ==========================================
         * SAFETY ROLLBACK
         * ========================================== */

        if (createdOrderId !== null) {
            try {
                await rollbackCheckoutOrder(
                    createdOrderId,
                    {
                        restoreCart: false,
                    }
                );
            } catch (rollbackError) {
                console.error(
                    "FINAL ROLLBACK ERROR:",
                    rollbackError
                );
            }
        }

        /* ==========================================
         * IPAYMU MIN-AMOUNT RULE
         * ==========================================
         *
         * Only QRIS is available below Rp10.000. The error thrown by
         * createDirectOrderPayment is answered with a structured,
         * friendly message instead of the generic failure text.
         */

        if (isIpaymuMinAmountError(error)) {
            console.error(
                JSON.stringify({
                    event: "CHECKOUT_MIN_AMOUNT_REJECTED",
                    checkoutType: "CART_IPAYMU",
                    orderId: createdOrderId,
                    amount: error.amount,
                    method: error.method,
                    timestamp: new Date().toISOString(),
                })
            );

            return NextResponse.json(
                {
                    success: false,
                    code: error.code,
                    message: error.message,
                    detail: error.suggestion,
                },
                { status: 400 }
            );
        }

        const status = Number.isInteger(
            error?.status
        )
            ? error.status
            : 500;

        return NextResponse.json(
            {
                success: false,

                message: "Gagal membuat pembayaran iPaymu.",
            },
            {
                status,
            }
        );
    }
}
