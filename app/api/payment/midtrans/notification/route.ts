import {
    NextRequest,
    NextResponse,
} from "next/server";

import crypto from "crypto";

import {
    Prisma,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { releaseStockAndVoucherForOrder } from "@/lib/order-stock";

export const dynamic =
    "force-dynamic";

type MidtransNotification = {
    order_id?: string;
    transaction_id?: string;
    transaction_status?: string;
    fraud_status?: string;
    status_code?: string;
    gross_amount?: string;
    signature_key?: string;
    payment_type?: string;
    transaction_time?: string;
    settlement_time?: string;
};

function verifySignature(
    notification: MidtransNotification
) {
    const serverKey =
        process.env
            .MIDTRANS_SERVER_KEY;

    if (!serverKey) {
        return false;
    }

    if (
        !notification.order_id ||
        !notification.status_code ||
        !notification.gross_amount ||
        !notification.signature_key
    ) {
        return false;
    }

    const raw =
        `${notification.order_id}${notification.status_code}${notification.gross_amount}${serverKey}`;    const expected =
        crypto
            .createHash(
                "sha512"
            )
            .update(raw)
            .digest("hex");

        /*
         * timingSafeEqual THROWS when buffer lengths differ,
         * which turned malformed signatures into HTTP 500.
         * Guard the length check first.
         */
        if (
            typeof notification.signature_key !==
                "string" ||
            notification.signature_key.length !==
                expected.length
        ) {
            return false;
        }

        return crypto.timingSafeEqual(
        Buffer.from(
            expected,
            "utf8"
        ),
        Buffer.from(
            notification.signature_key,
            "utf8"
        )
    );
}

function json(
    data: unknown,
    status = 200
) {
    return NextResponse.json(
        data,
        { status }
    );
}



export async function POST(
    request: NextRequest
) {
    try {
        const body =
            (await request.json()) as MidtransNotification;

        console.log(
            "MIDTRANS NOTIFICATION:",
            {
                order_id:
                    body.order_id,

                transaction_id:
                    body.transaction_id,

                transaction_status:
                    body.transaction_status,

                payment_type:
                    body.payment_type,
            }
        );

        /*
         * ========================================================
         * VERIFY SIGNATURE
         * ========================================================
         */

        if (
            !verifySignature(
                body
            )
        ) {
            console.error(
                "MIDTRANS INVALID SIGNATURE"
            );

            return json(
                {
                    success:
                        false,
                    message:
                        "Invalid signature.",
                },
                401
            );
        }

        const orderNumber =
            body.order_id;

        if (
            !orderNumber
        ) {
            return json(
                {
                    success:
                        false,
                    message:
                        "order_id tidak ditemukan.",
                },
                400
            );
        }

        const transactionStatus =
            body.transaction_status;

        if (
            !transactionStatus
        ) {
            return json(
                {
                    success:
                        false,
                    message:
                        "transaction_status tidak ditemukan.",
                },
                400
            );
        }

        /*
         * ========================================================
         * FIND ORDER
         * ========================================================
         */

        const existingOrder =
            await prisma.order.findUnique(
                {
                    where: {
                        orderNumber,
                    },

                    include: {
                        items:
                            true,
                    },
                }
            );

        if (
            !existingOrder
        ) {
            console.error(
                "MIDTRANS ORDER NOT FOUND:",
                orderNumber
            );

            /*
             * Tetap 200 supaya Midtrans tidak retry
             * terus-menerus untuk order yang memang
             * tidak ada.
             */
            return json({
                success:
                    false,

                message:
                    "Order tidak ditemukan.",
            });
        }

        /*
         * ========================================================
         * NOMINAL VALIDATION
         * ========================================================
         *
         * Jangan menerima notification dengan nominal
         * berbeda dari Order.
         */

        if (
            body.gross_amount
        ) {
            const notificationAmount =
                Number(
                    body.gross_amount
                );

            const orderAmount =
                Number(
                    existingOrder.total.toString()
                );

            if (
                !Number.isFinite(
                    notificationAmount
                ) ||
                notificationAmount !==
                orderAmount
            ) {
                console.error(
                    "MIDTRANS GROSS AMOUNT MISMATCH:",
                    {
                        orderNumber,
                        notificationAmount,
                        orderAmount,
                    }
                );

                return json(
                    {
                        success:
                            false,
                        message:
                            "Gross amount tidak sesuai.",
                    },
                    400
                );
            }
        }

        /*
         * ========================================================
         * STATUS MAPPING
         * ========================================================
         */

        const isSuccess =
            transactionStatus ===
            "settlement" ||
            (
                transactionStatus ===
                "capture" &&
                (
                    !body.fraud_status ||
                    body.fraud_status ===
                    "accept"
                )
            );

        const isPending =
            transactionStatus ===
            "pending";

        const isFailed =
            transactionStatus ===
            "deny" ||
            transactionStatus ===
            "cancel" ||
            transactionStatus ===
            "failure";

        const isExpired =
            transactionStatus ===
            "expire";

        const isRefunded =
            transactionStatus ===
            "refund";

        /*
         * ========================================================
         * SUCCESS
         * ========================================================
         */

        if (isSuccess) {
            /*
             * ========================================================
             * ATOMIC CAS SETTLEMENT GUARD (P0 FIX C4)
             * ========================================================
             *
             * State machine policy (consistent with the expire/fail
             * paths below and with admin PATCH transitions):
             *
             *   PENDING / PROCESSING → PAID   (allowed)
             *   PAID                  → PAID  (idempotent no-op)
             *   CANCELLED / EXPIRED / FAILED → final, NEVER resurrected
             *   REFUNDED              → final, never overwritten
             *
             * Previously this path only did findUnique() + if + update,
             * so a late settlement notification could resurrect a
             * CANCELLED/EXPIRED order to PAID AFTER its stock had
             * already been released by the expire/fail handler —
             * causing oversell / negative stock.
             *
             * The conditional UPDATE makes transition, idempotency and
             * resurrection-prevention a single atomic operation.
             */
            const settledRef =
                body.transaction_id || null;

            let settled = false;

            await prisma.$transaction(async (tx) => {
                const affectedRows =
                    await tx.$executeRaw`
                    UPDATE \`order\`
                    SET status = 'PAID',
                        paymentStatus = 'PAID',
                        paidAt = IFNULL(paidAt, CURRENT_TIMESTAMP),
                        paymentReference = COALESCE(${settledRef}, paymentReference)
                    WHERE id = ${existingOrder.id}
                      AND status IN ('PENDING', 'PROCESSING')
                      AND paymentStatus NOT IN ('PAID', 'REFUNDED')
                `;

                if (affectedRows === 0) {
                    /*
                     * Either already PAID (duplicate settlement → idempotent)
                     * or CANCELLED/EXPIRED/REFUNDED (final state — do not
                     * resurrect). Stock must NOT be touched in either case.
                     */
                    return;
                }

                settled = true;

                /*
                 * Kosongkan cart HANYA kalau order ini
                 * berasal dari checkout cart (bukan buy-now,
                 * bukan COD yang sudah dihapus di endpoint lain).
                 */
                if (
                    existingOrder.orderNumber.startsWith(
                        "PAY-CART-"
                    )
                ) {
                    const cart = await tx.cart.findUnique({
                        where: { userId: existingOrder.userId },
                    });

                    if (cart) {
                        // ==========================================
                        // SELECTIVE CART CLEANUP
                        // ==========================================
                        // Only remove cart items that became
                        // OrderItems. Unselected items stay.
                        const orderItems = await tx.orderItem.findMany({
                            where: { orderId: existingOrder.id },
                            select: { variantId: true },
                        });
                        const orderedVariantIds = orderItems
                            .map((oi) => oi.variantId)
                            .filter((v): v is number => v !== null);

                        if (orderedVariantIds.length > 0) {
                            await tx.cartItem.deleteMany({
                                where: {
                                    cartId: cart.id,
                                    variantId: { in: orderedVariantIds },
                                },
                            });
                        }
                    }
                }
            });

            /*
             * ==========================================
             * NOTIFICATION TRIGGER
             * ==========================================
             *
             * Fire-and-forget, hanya bila transisi
             * benar-benar terjadi (bukan duplicate).
             * Notification error tidak boleh
             * mempengaruhi webhook response.
             */
            if (settled) {
                const { onOrderStatusChanged } =
                    await import(
                        "@/lib/notification/order-status-handler"
                    );

                onOrderStatusChanged(
                    existingOrder.id,
                    existingOrder.status,
                    "PAID"
                ).catch((err) =>
                    console.error(
                        "NOTIFICATION TRIGGER ERROR:",
                        err
                    )
                );

                /*
                 * TIKTOK EVENTS API — server-side CompletePayment.
                 *
                 * Fires ONLY after the atomic CAS actually settled
                 * this order (authoritative PAID). Fire-and-forget:
                 * the service never throws, so a TikTok failure can
                 * never affect settlement.
                 */
                const {
                    trackTikTokServerCompletePayment,
                } = await import(
                    "@/lib/analytics/tiktok-events-api"
                );

                await trackTikTokServerCompletePayment({
                    orderNumber:
                        existingOrder.orderNumber,
                    total: existingOrder.total,
                    items: existingOrder.items,
                });
            }

            return json({
                success: true,
                message: settled
                    ? "Payment settlement processed."
                    : "Settlement ignored: order already processed or cancelled/expired.",
            });
        }

        /*
         * ========================================================
         * PENDING
         * ========================================================
         */

        if (
            isPending
        ) {
            /*
             * BUG #2 FIX: Do NOT revert PAID orders.
             * Atomic CAS prevents delayed pending webhook
             * from overriding a settled payment.
             */
            const pendingRef =
                body.transaction_id ||
                existingOrder.paymentReference;

            const pendingAffected =
                await prisma.$executeRaw`
                UPDATE \`order\`
                SET status = 'PENDING',
                    paymentStatus = 'PENDING',
                    paymentReference = ${pendingRef}
                WHERE id = ${existingOrder.id}
                  AND status IN ('PENDING', 'PROCESSING')
                  AND paymentStatus != 'PAID'
            `;

            return json({
                success:
                    true,

                message:
                    pendingAffected > 0
                        ? "Payment pending processed."
                        : "Order already paid, pending ignored.",
            });
        }

        /*
         * ========================================================
         * EXPIRED
         * ========================================================
         */
        if (
            isExpired
        ) {
            await prisma.$transaction(
                async (tx) => {
                    /*
                     * ATOMIC CAS (BUG #1/#4 FIX):
                     * Only transition PENDING/PROCESSING -> CANCELLED.
                     * Prevents concurrent webhooks from double-restoring stock.
                     */
                    const expiredRef =
                        body.transaction_id ||
                        existingOrder.paymentReference;

                    const affectedRows =
                        await tx.$executeRaw`
                        UPDATE \`order\`
                        SET status = 'CANCELLED',
                            paymentStatus = 'EXPIRED',
                            paymentReference = ${expiredRef}
                        WHERE id = ${existingOrder.id}
                          AND status IN ('PENDING', 'PROCESSING')
                          AND paymentStatus != 'PAID'
                    `;

                    if (affectedRows === 0) {
                        return;
                    }

                    await releaseStockAndVoucherForOrder(
                        tx,
                        existingOrder.id
                    );

                    /*
                     * AFFILIATE COMMISSION CANCELLATION:
                     * Cancel commission when order expires.
                     */
                    const { cancelCommissionForOrder } =
                        await import("@/lib/affiliate/cancel-commission");
                    await cancelCommissionForOrder(
                        tx,
                        existingOrder.id,
                        "ORDER_EXPIRED"
                    );
                }
            );

            /*
             * NOTIFICATION TRIGGER
             */
            if (existingOrder.status !== "CANCELLED") {
                const { onOrderStatusChanged } =
                    await import(
                        "@/lib/notification/order-status-handler"
                    );

                onOrderStatusChanged(
                    existingOrder.id,
                    existingOrder.status,
                    "CANCELLED"
                ).catch((err) =>
                    console.error(
                        "NOTIFICATION TRIGGER ERROR:",
                        err
                    )
                );
            }

            return json({
                success:
                    true,

                message:
                    "Payment expired processed.",
            });
        }

        /*
         * ========================================================
         * DENY / CANCEL / FAILURE
         * ========================================================
         */
        if (
            isFailed
        ) {
            await prisma.$transaction(
                async (tx) => {
                    /*
                     * ATOMIC CAS (BUG #1/#4 FIX):
                     * Only transition PENDING/PROCESSING -> CANCELLED.
                     * Prevents concurrent webhooks from double-restoring stock.
                     */
                    const failedRef =
                        body.transaction_id ||
                        existingOrder.paymentReference;

                    const affectedRows =
                        await tx.$executeRaw`
                        UPDATE \`order\`
                        SET status = 'CANCELLED',
                            paymentStatus = 'FAILED',
                            paymentReference = ${failedRef}
                        WHERE id = ${existingOrder.id}
                          AND status IN ('PENDING', 'PROCESSING')
                          AND paymentStatus != 'PAID'
                    `;

                    if (affectedRows === 0) {
                        return;
                    }

                    await releaseStockAndVoucherForOrder(
                        tx,
                        existingOrder.id
                    );

                    /*
                     * AFFILIATE COMMISSION CANCELLATION:
                     * Cancel commission when payment fails.
                     */
                    const { cancelCommissionForOrder } =
                        await import("@/lib/affiliate/cancel-commission");
                    await cancelCommissionForOrder(
                        tx,
                        existingOrder.id,
                        "ORDER_PAYMENT_FAILED"
                    );
                }
            );

            /*
             * NOTIFICATION TRIGGER
             */
            if (existingOrder.status !== "CANCELLED") {
                const { onOrderStatusChanged } =
                    await import(
                        "@/lib/notification/order-status-handler"
                    );

                onOrderStatusChanged(
                    existingOrder.id,
                    existingOrder.status,
                    "CANCELLED"
                ).catch((err) =>
                    console.error(
                        "NOTIFICATION TRIGGER ERROR:",
                        err
                    )
                );
            }

            return json({
                success:
                    true,

                message:
                    "Payment failure processed.",
            });
        }

        /*
         * ========================================================
         * REFUND
         * ========================================================
         */
        if (
            isRefunded
        ) {
            /*
             * REFUND WEBHOOK HANDLER
             *
             * Uses shared executeRefundCompletion() for consistent
             * refund processing across admin and webhook paths.
             *
             * Steps:
             * 1. Find or create Refund record
             * 2. Call executeRefundCompletion() (CAS + restore)
             */
            const refundedRef = body.transaction_id || existingOrder.paymentReference;

            /*
             * FIND OR CREATE REFUND RECORD:
             * - If user-initiated refund exists → use it
             * - If provider-initiated (no existing record) → create one
             */
            let existingRefund = await prisma.refund.findUnique({
                where: { orderId: existingOrder.id },
                select: { id: true, status: true },
            });

            if (!existingRefund) {
                /*
                 * Provider-initiated refund (not user-requested).
                 * Create a Refund record for tracking.
                 * Amount is SERVER-AUTHORITATIVE: order.total from DB.
                 */
                const newRefund = await prisma.refund.create({
                    data: {
                        orderId: existingOrder.id,
                        amount: existingOrder.total,
                        status: "PROCESSING",
                        requestedBy: "PROVIDER",
                        providerRef: refundedRef || undefined,
                    },
                });
                existingRefund = { id: newRefund.id, status: "PROCESSING" };
            }

            /*
             * CAS-PROTECTED TRANSITION + COMPLETION:
             * transitionRefundForWebhook handles:
             * 1. CAS: PENDING → PROCESSING (prevents resurrection)
             * 2. Re-read on CAS failure (handles concurrent admin actions)
             * 3. Returns shouldComplete flag for safe delegation
             */
            const { transitionRefundForWebhook, executeRefundCompletion } = await import(
                "@/lib/refund"
            );
            const transition = await transitionRefundForWebhook(
                existingRefund.id,
                refundedRef || undefined
            );

            if (!transition.shouldComplete) {
                return json({
                    success: true,
                    message: `Refund already ${transition.status} (idempotent).`,
                });
            }

            /*
             * EXECUTE REFUND COMPLETION:
             * Shared function handles CAS, stock, voucher,
             * affiliate, spin-wheel, and audit logging.
             * Idempotent: duplicate webhooks return safe no-op.
             */
            const result = await executeRefundCompletion(
                existingRefund.id,
                refundedRef || undefined,
                "MIDTRANS_WEBHOOK"
            );

            return json({
                success: true,
                message: result.ok
                    ? "Refund processed, stock and voucher restored."
                    : "Refund already processed (idempotent).",
            });
        }

        /*
         * Status lain yang belum kita mapping.
         */
        console.log(
            "MIDTRANS UNHANDLED STATUS:",
            transactionStatus
        );

        return json({
            success:
                true,

            message:
                `Status ${transactionStatus} diterima tetapi belum membutuhkan perubahan order.`,
        });
    } catch (error) {
        console.error(
            "MIDTRANS WEBHOOK ERROR:",
            error
        );

        /*
         * 500 membuat Midtrans melakukan retry.
         *
         * Ini bagus kalau database sementara error.
         */
        return json(
            {
                success:
                    false,

                message:
                    "Webhook processing failed.",
            },
            500
        );
    }
}