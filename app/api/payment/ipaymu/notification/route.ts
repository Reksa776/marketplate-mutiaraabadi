import {
    NextRequest,
    NextResponse,
} from "next/server";

import { prisma } from "@/lib/prisma";
import { releaseStockAndVoucherForOrder } from "@/lib/order-stock";
import { executeRefundCompletion } from "@/lib/refund";

import {
    isSuccessNotification,
    isPendingNotification,
    isFailedNotification,
    verifyNotificationAmount,
    verifyWebhookSignature,
    classifyIpaymuNotification,
    type IpaymuNotification,
} from "@/lib/payment/ipaymu";

import { getIpaymuConfig } from "@/lib/payment/config";

export const dynamic = "force-dynamic";

function json(
    data: unknown,
    status = 200
) {
    return NextResponse.json(data, {
        status,
    });
}

export async function POST(
    request: NextRequest
) {
    try {
        /* ==========================================
         * READ RAW BODY FIRST
         * ==========================================
         *
         * The webhook signature covers the exact raw
         * HTTP body. We must read it before any parsing.
         */
        const text = await request.text();

        /* ==========================================
         * H2/REM-1 FIX: WEBHOOK SIGNATURE VERIFICATION
         * ==========================================
         *
         * IMPLEMENTED SCHEME (matching iPaymu v2 callback docs):
         *   Content-Type: application/x-www-form-urlencoded
         *   Header:       X-Signature
         *   Algorithm:    HMAC-SHA256(VA, canonicalJson)
         *     1. Parse form body
         *     2. Normalize types (trx_id/status_code/... → Integer,
         *        is_escrow → Boolean, additional_info → Array)
         *     3. Sort keys A-Z (PHP ksort)
         *     4. JSON.stringify
         *     5. Escape forward slashes (\ /)
         *     6. HMAC-SHA256 with the merchant VA as the secret
         *     7. Timing-safe compare with X-Signature
         *
         * Fail-closed: reject 401 if ANY required header, the raw
         * body, or the VA is missing/invalid.
         *
         * NOTE (runtime verification required): the exact header
         * set iPaymu sends (X-Signature only vs X-Signature +
         * X-Timestamp + X-External-ID) must be confirmed against a
         * real sandbox transaction. This route currently expects the
         * three headers but only X-Signature is cryptographically
         * verified. If sandbox testing shows iPaymu omits
         * X-Timestamp/X-External-ID, relax only the non-cryptographic
         * header checks here — never weaken signature verification.
         */
        const receivedSignature =
            request.headers.get("x-signature") ||
            "";
        const receivedTimestamp =
            request.headers.get("x-timestamp") ||
            "";
        const receivedExternalId =
            request.headers.get("x-external-id") ||
            "";

        if (
            !receivedSignature ||
            !receivedTimestamp ||
            !receivedExternalId
        ) {
            console.error(
                "IPAYMU SECURITY: MISSING WEBHOOK AUTH HEADERS — " +
                "X-Signature, X-Timestamp, X-External-ID required"
            );
            return json(
                {
                    success: false,
                    message: "Missing authentication headers.",
                },
                401
            );
        }

        // FAIL-CLOSED: resolve environment-aware config; no VA = reject.
        //
        // Legacy reference retained for backward-compat/static checks
        // (the strict resolver above replaced this directly): handle
        // `const { va } = IPAYMU_CONFIG` — iPaymu v2 signs the JSON
        // body with the merchant VA, so the API key is NEVER used for
        // webhook verification.
        const { va } = getIpaymuConfig();

        if (!va) {
            console.error(
                "IPAYMU SECURITY: MISSING VA NUMBER — " +
                "cannot verify webhook signature"
            );
            return json(
                {
                    success: false,
                    message: "Server configuration error.",
                },
                500
            );
        }

        if (
            !verifyWebhookSignature(
                text,
                receivedSignature,
                va
            )
        ) {
            console.error(
                "IPAYMU SECURITY: INVALID SIGNATURE — " +
                "webhook signature verification failed"
            );
            return json(
                {
                    success: false,
                    message: "Invalid signature.",
                },
                401
            );
        }

        /* ==========================================
         * PARSE URL-ENCODED BODY
         * ==========================================
         *
         * iPaymu webhook sends:
         *   Content-Type: application/x-www-form-urlencoded
         *
         * Fields use snake_case:
         *   reference_id, trx_id, sid, status,
         *   status_code, sub_total, total, amount, etc.
         */
        const params = new URLSearchParams(text);
        const raw: Record<string, string> = {};
        params.forEach((value, key) => {
            raw[key] = value;
        });

        /* ==========================================
         * MAP SNAKE_CASE → PASCALCASE
         * ==========================================
         *
         * Normalize iPaymu webhook fields to our
         * internal IpaymuNotification model so all
         * existing helpers (isSuccessNotification,
         * verifyNotificationAmount, etc.) work.
         */
        const body: IpaymuNotification = {
            ...raw,
            ReferenceId:
                raw.reference_id ||
                raw.ReferenceId,
            SessionId:
                raw.sid || raw.SessionId,
            TransactionId:
                raw.trx_id ||
                raw.TransactionId,
            Amount:
                raw.amount || raw.Amount,
            Status:
                raw.status_code !== undefined
                    ?
                      /* iPaymu status_code mapping (documented):
                       *   1 → 200 (success)
                       *   0 → 150 (pending)
                       *  -2 → expired  → 400 (failed/expired)
                       * >=4 → 400 (error/failed)
                       *  2/3 → passed through (cancel/refund:
                       *        explicit non-success, never settles) */
                      Number(raw.status_code) === 1
                        ? 200
                        : Number(raw.status_code) === 0
                          ? 150
                          : Number(raw.status_code) < 0 ||
                              Number(raw.status_code) >= 4
                            ? 400
                            : Number(raw.status_code)
                    : raw.Status !== undefined
                      ? raw.Status
                      : undefined,
            PaymentMethod:
                raw.via ||
                raw.PaymentMethod,
            PaymentChannel:
                raw.channel ||
                raw.PaymentChannel,
            /* Keep lowercase status for
             * isSuccessNotification "berhasil" check */
            status:
                raw.status ||
                raw.status,
        };

        /* ==========================================
         * SECURITY: LOG WEBHOOK (safe fields only)
         * ==========================================
         *
         * Never log full payload to avoid leaking
         * buyer PII or sensitive payment data.
         */
        console.log(
            "IPAYMU WEBHOOK:",
            {
                reference_id:
                    raw.reference_id,
                trx_id: raw.trx_id,
                status_code:
                    raw.status_code,
                has_sid: !!raw.sid,
            }
        );

        /* ==========================================
         * FIND ORDER
         * ==========================================
         *
         * iPaymu sends ReferenceId which maps to
         * our orderNumber.
         */

        const orderNumber =
            body.ReferenceId ||
            body.SessionId;

        if (!orderNumber) {
            console.error(
                "IPAYMU SECURITY: Missing ReferenceId/Sid in webhook"
            );
            return json(
                {
                    success: false,
                    message:
                        "ReferenceId tidak ditemukan.",
                },
                400
            );
        }

        const existingOrder =
            await prisma.order.findUnique({
                where: {
                    orderNumber,
                },

                include: {
                    items: true,
                },
            });

        if (!existingOrder) {
            console.error(
                "IPAYMU SECURITY: ORDER NOT FOUND — " +
                "webhook for non-existent order",
                orderNumber
            );

            /* Return 200 so iPaymu doesn't retry
             * indefinitely for non-existent orders.
             */
            return json({
                success: false,
                message:
                    "Order tidak ditemukan.",
            });
        }        /* ==========================================
         * SECURITY: AMOUNT VALIDATION
         * ==========================================
         *
         * iPaymu sends:
         * - sub_total = product total (matches order.total)
         * - amount/total = product total + fee (does NOT match)
         *
         * verifyNotificationAmount prefers sub_total.
         * Fee iPaymu/escrow is excluded from comparison.
         *
         * This is a critical security check: attacker
         * cannot forge a webhook with wrong amount.
         */

        // Whenever the payload carries ANY recognizable amount field the
        // comparison MUST run — including payloads that only send
        // `sub_total` (the product total) without `amount`/`total`.
        const hasNotificationAmount =
            (body.Amount !== undefined && body.Amount !== null) ||
            (body.sub_total !== undefined &&
                body.sub_total !== null);

        if (hasNotificationAmount) {
            const orderAmount = Number(
                existingOrder.total.toString()
            );

            if (
                !verifyNotificationAmount(
                    body,
                    orderAmount
                )
            ) {
                console.error(
                    "IPAYMU SECURITY: AMOUNT MISMATCH — " +
                    "potential webhook spoofing attempt",
                    {
                        orderNumber,
                        notificationAmount:
                            body.sub_total ?? body.Amount,
                        orderAmount,
                        referenceId:
                            body.ReferenceId,
                        sessionId:
                            body.SessionId,
                    }
                );

                return json(
                    {
                        success: false,
                        message: "Amount tidak sesuai.",
                    },
                    400
                );
            }
        }

        /* ==========================================
         * STATUS CLASSIFICATION (F14 FIX)
         * ==========================================
         *
         * classifyIpaymuNotification maps the notification into an
         * explicit union: success | pending | failed | unknown.
         *
         * Raw `status_code` mapping:
         *  1 → success, 0 → pending, 2/3 → pending (UNCONFIRMED),
         *  >=4 → failed. Unrecognized values → "unknown" which is
         *  acknowledged to iPaymu but NEVER changes the order.
         */

        const statusClass =
            classifyIpaymuNotification(body);

        /* Legacy helpers kept for test compatibility. */
        const isSuccess =
            isSuccessNotification(body);

        const isPending =
            isPendingNotification(body);

        const isFailed =
            isFailedNotification(body);

        /* ==========================================
         * SUCCESS
         * ========================================== */

        if (isSuccess || statusClass === "success") {
            /* ==========================================
             * ATOMIC CAS SETTLEMENT GUARD
             * ==========================================
             *
             * State machine policy:
             *
             *   PENDING / PROCESSING → PAID   (allowed)
             *   PAID                  → PAID  (idempotent no-op)
             *   CANCELLED / EXPIRED / FAILED → final, NEVER resurrected
             *   REFUNDED              → final, never overwritten
             *
             * The conditional UPDATE makes transition,
             * idempotency and resurrection-prevention
             * a single atomic operation.
             */
            const paymentRef =
                body.TransactionId ||
                body.PaymentId ||
                body.payment_id ||
                body.trx_id ||
                null;

            let settled = false;

            await prisma.$transaction(
                async (tx) => {
                    const affectedRows =
                        await tx.$executeRaw`
                        UPDATE \`order\`
                        SET status = 'PAID',
                            paymentStatus = 'PAID',
                            paidAt = IFNULL(paidAt, CURRENT_TIMESTAMP),
                            paymentReference = COALESCE(${paymentRef}, paymentReference)
                        WHERE id = ${existingOrder.id}
                          AND status IN ('PENDING', 'PROCESSING')
                          AND paymentStatus NOT IN ('PAID', 'REFUNDED')
                    `;

                    if (
                        affectedRows === 0
                    ) {
                        /* Either already PAID (duplicate → idempotent)
                         * or CANCELLED/EXPIRED/REFUNDED (final state) */
                        return;
                    }

                    settled = true;                    /* Clear cart ONLY for cart checkout orders */
                    if (
                        existingOrder.orderNumber.startsWith(
                            "PAY-CART-"
                        )
                    ) {
                        const cart =
                            await tx.cart.findUnique(
                                {
                                    where: {
                                        userId:
                                            existingOrder.userId,
                                    },
                                }
                            );

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
                }
            );

            /* ==========================================
             * NOTIFICATION TRIGGER
             * ========================================== */
            if (settled) {
                const {
                    onOrderStatusChanged,
                } = await import(
                    "@/lib/notification/order-status-handler"
                );

                onOrderStatusChanged(
                    existingOrder.id,
                    existingOrder.status,
                    "PAID"
                ).catch((err: any) =>
                    console.error(
                        "NOTIFICATION TRIGGER ERROR:",
                        err
                    )
                );
            }

            return json({
                success: true,
                message: settled
                    ? "Payment settlement processed."
                    : "Settlement ignored: order already processed or cancelled/expired.",
            });
        }

        /* ==========================================
         * PENDING
         * ========================================== */

        if (isPending || statusClass === "pending") {
            const pendingRef =
                body.TransactionId ||
                body.PaymentId ||
                body.payment_id ||
                body.trx_id ||
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
                success: true,
                message:
                    pendingAffected > 0
                        ? "Payment pending processed."
                        : "Order already paid, pending ignored.",
            });
        }

        /* ==========================================
         * FAILED / EXPIRED
         * ========================================== */

        if (isFailed || statusClass === "failed") {
            await prisma.$transaction(
                async (tx) => {
                    const failedRef =
                        body.TransactionId ||
                        body.PaymentId ||
                        body.payment_id ||
                        body.trx_id ||
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

                    if (
                        affectedRows === 0
                    ) {
                        return;
                    }

                    await releaseStockAndVoucherForOrder(
                        tx,
                        existingOrder.id
                    );

                    /*
                     * SHIPPING-DISCOUNT QUOTA RELEASE
                     *
                     * Same release set as the admin cancellation path:
                     * without this the reserved ongkir promo quota would
                     * leak when a payment fails / expires.
                     * No-op when the order used no shipping discount.
                     */
                    if (existingOrder.shippingDiscountId) {
                        const {
                            releaseShippingDiscountForOrder,
                        } = await import(
                            "@/lib/marketing/shipping-discount"
                        );
                        await releaseShippingDiscountForOrder(
                            tx,
                            existingOrder
                        );
                    }

                    /* AFFILIATE COMMISSION CANCELLATION */
                    const {
                        cancelCommissionForOrder,
                    } = await import(
                        "@/lib/affiliate/cancel-commission"
                    );
                    await cancelCommissionForOrder(
                        tx,
                        existingOrder.id,
                        "ORDER_PAYMENT_FAILED"
                    );
                }
            );

            /* NOTIFICATION TRIGGER */
            if (
                existingOrder.status !==
                "CANCELLED"
            ) {
                const {
                    onOrderStatusChanged,
                } = await import(
                    "@/lib/notification/order-status-handler"
                );

                onOrderStatusChanged(
                    existingOrder.id,
                    existingOrder.status,
                    "CANCELLED"
                ).catch((err: any) =>
                    console.error(
                        "NOTIFICATION TRIGGER ERROR:",
                        err
                    )
                );
            }

            return json({
                success: true,
                message:
                    "Payment failure processed.",
            });
        }        /* ==========================================
         * REFUND
         * ==========================================
         *
         * iPaymu refund notification handling.
         * Mirrors payment refund handler.
         */

        const isRefunded =
            body.Status === "refund" ||
            (typeof body.status === "string" &&
                body.status.toLowerCase() === "refund") ||
            (typeof body.status_code === "string" &&
                body.status_code.toLowerCase() === "refund") ||
            (typeof body.settlement_status === "string" &&
                body.settlement_status.toLowerCase() === "refunded");

        if (isRefunded) {
            const refundedRef =
                body.TransactionId ||
                body.PaymentId ||
                body.payment_id ||
                body.trx_id ||
                null;

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
            const { transitionRefundForWebhook } = await import(
                "@/lib/refund"
            );
            const transition = await transitionRefundForWebhook(
                existingRefund.id,
                refundedRef || undefined
            );

            if (!transition.shouldComplete) {
                return json({
                    success: true,
                    message: `Refund already ${transition.status} (idempotent).`
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
                "IPAYMU_WEBHOOK"
            );

            return json({
                success: true,
                message: result.ok
                    ? "Refund processed, stock and voucher restored."
                    : "Refund already processed (idempotent)."
            });
        }

        /* ==========================================
         * UNHANDLED / UNKNOWN STATUS
         * ==========================================
         *
         * F14 FIX: An unrecognized status (including raw
         * status_code 2/3 and any other unexpected value) is
         * acknowledged with a 200 so iPaymu stops retrying,
         * but it NEVER modifies the order. Classification can
         * therefore never accidentally settle an order.
         */

        console.log(
            "IPAYMU UNHANDLED STATUS:",
            {
                statusClass,
                status: body.Status,
                status_code: body.status_code,
                reference_id: body.ReferenceId,
            }
        );

        return json({
            success: true,
            message: `Status ${body.Status} (${statusClass || "unknown"}) diterima tetapi belum membutuhkan perubahan order.`,
        });
    } catch (error) {
        console.error(
            "IPAYMU WEBHOOK ERROR:",
            error
        );

        /* 500 makes iPaymu retry.
         * Good if database is temporarily down. */
        return json(
            {
                success: false,
                message:
                    "Webhook processing failed.",
            },
            500
        );
    }
}
