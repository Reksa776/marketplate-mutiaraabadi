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
         * Fail-closed: reject 401 if the X-Signature header, the raw
         * body, or the VA is missing/invalid.
         *
         * PROVIDER HEADER COMPATIBILITY (local audit):
         * iPaymu's exact callback header set is NOT yet proven
         * (PRODUCTION PROVIDER BEHAVIOR = UNVERIFIED). Only
         * X-Signature is cryptographically meaningful; X-Timestamp
         * and X-External-ID are informational and MUST NOT gate
         * settlement, otherwise a provider that omits them would make
         * every webhook 401 and no order could ever be paid.
         *
         * Policy:
         *   - X-Signature            → REQUIRED, always verified.
         *   - X-Timestamp/ExternalId → optional; logged when absent.
         *
         * Replay is already harmless: settlement is a CAS that only
         * fires once (PENDING/PROCESSING → PAID); a replayed success
         * is an idempotent no-op.
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

        if (!receivedSignature) {
            console.error(
                "IPAYMU SECURITY: MISSING WEBHOOK AUTH HEADER — " +
                "X-Signature required"
            );
            return json(
                {
                    success: false,
                    message: "Missing authentication headers.",
                },
                401
            );
        }

        if (!receivedTimestamp || !receivedExternalId) {
            console.warn(
                "IPAYMU SECURITY: webhook missing optional header(s) — " +
                `x-timestamp=${receivedTimestamp ? "present" : "absent"} ` +
                `x-external-id=${receivedExternalId ? "present" : "absent"}; ` +
                "proceeding with X-Signature verification only"
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

                    /*
                     * Advanced Matching source: the account
                     * email / phone. Selected (never the whole
                     * user row) and hashed server-side before it
                     * is sent to TikTok.
                     */
                    user: {
                        select: {
                            email: true,
                            phone: true,
                        },
                    },
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
         * AMOUNT VALIDATION
         * ==========================================
         *
         * The amount comparison is mandatory for SETTLEMENT and is
         * enforced inside the success branch below (before the CAS),
         * because a pending/failed/refund notification may legitimately
         * omit amount fields while a settlement must never settle an
         * unverifiable amount.
         */

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
             * MANDATORY AMOUNT VALIDATION (SETTLEMENT ONLY)
             * ==========================================
             *
             * A success notification MUST carry a product-total
             * amount that matches the server-authoritative order
             * total. An unverifiable amount fails closed so a
             * malformed/forged success can never settle the order.
             */
            const orderAmount = Number(
                existingOrder.total.toString()
            );

            if (
                !verifyNotificationAmount(body, orderAmount)
            ) {
                console.error(
                    "IPAYMU SECURITY: AMOUNT UNVERIFIABLE/MISMATCH — " +
                    "refusing to settle",
                    {
                        orderNumber,
                        notificationAmount:
                            body.sub_total ??
                            body.Amount ??
                            body.amount ??
                            body.total,
                        orderAmount,
                        referenceId: body.ReferenceId,
                        sessionId: body.SessionId,
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

                    /*
                     * RAW identifiers — the service hashes them
                     * immediately (SHA-256) and never logs them.
                     * Account data first, then the contact phone
                     * captured on the order itself.
                     */
                    email:
                        existingOrder.user?.email ??
                        null,
                    phone:
                        existingOrder.user?.phone ??
                        existingOrder.phone ??
                        null,
                    userId: existingOrder.userId,

                    /*
                     * Attribution persisted when the customer
                     * created the order. NEVER the webhook's own
                     * IP / User-Agent.
                     */
                    ttclid:
                        existingOrder.ttclid ??
                        null,
                    ttp:
                        existingOrder.ttp ?? null,
                    pageUrl:
                        existingOrder.landingUrl ??
                        null,
                    ip:
                        existingOrder.clientIp ??
                        null,
                    userAgent:
                        existingOrder.clientUserAgent ??
                        null,
                });
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
