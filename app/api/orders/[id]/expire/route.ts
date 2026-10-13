import { NextResponse } from "next/server";

import { rateLimiters } from "@/lib/rate-limit";
import { expireUnpaidOrderIfExpired } from "@/lib/payment/order-payment";
import { authorizeOrderRequest } from "@/lib/guest-order-access";

export const dynamic = "force-dynamic";

/* ==========================================
 * POST /api/orders/[id]/expire
 * ==========================================
 *
 * Settles an UNPAID order whose provider payment window has closed.
 *
 * Called by the payment page when its countdown reaches zero, but the
 * decision is entirely server-side: the provider expiry stored on the
 * order (plus a grace period) must already have passed.
 *
 * This route can only CANCEL an unused reservation — it can never mark
 * an order as paid. The release itself is delegated to
 * rollbackCheckoutOrder() (atomic CAS + stock/voucher/shipping
 * discount/spin-wheel/affiliate handling), so no rollback logic is
 * duplicated and concurrent callers (webhook, checkout cleanup,
 * customer) stay safe.
 */
export async function POST(
    request: Request,
    context: {
        params: Promise<{
            id: string;
        }>;
    }
) {
    try {
        const { id } = await context.params;
        const orderId = Number(id);

        if (!Number.isInteger(orderId) || orderId <= 0) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Order ID tidak valid.",
                },
                { status: 400 }
            );
        }

        /*
         * OWNERSHIP FIRST, then rate limit the (now known) buyer.
         */
        const access = await authorizeOrderRequest(
            request,
            orderId
        );

        if (!access.ok) {
            return NextResponse.json(
                { success: false, message: access.message },
                { status: access.status }
            );
        }

        if (access.userId) {
            const rateLimit = rateLimiters.repayment(
                access.userId
            );

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
        }

        const result = await expireUnpaidOrderIfExpired(
            orderId,
            access.userId
        );

        if (result === "NOT_FOUND") {
            return NextResponse.json(
                {
                    success: false,
                    message: "Order tidak ditemukan.",
                },
                { status: 404 }
            );
        }

        if (result === "NOT_CANCELLABLE") {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Order tidak dalam keadaan menunggu pembayaran.",
                },
                { status: 409 }
            );
        }

        // NOT_EXPIRED → the payment window is still open (no state change).
        // EXPIRED     → the reservation was released by the lifecycle CAS.
        return NextResponse.json({
            success: true,
            data: {
                orderId,
                expired: result === "EXPIRED",
            },
        });
    } catch (error) {
        console.error("EXPIRE ORDER ERROR:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Gagal memproses kedaluwarsa pembayaran.",
            },
            { status: 500 }
        );
    }
}
