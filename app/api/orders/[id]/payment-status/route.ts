import { NextResponse } from "next/server";

import { loadPaymentView } from "@/lib/payment/order-payment";
import { authorizeOrderRequest } from "@/lib/guest-order-access";

export const dynamic = "force-dynamic";

/* ==========================================
 * GET /api/orders/[id]/payment-status
 * ==========================================
 *
 * Read-only status + payment instruction for the customer's payment
 * page (polling).
 *
 * SECURITY
 *  - authenticated + ownership-scoped: another user's order is
 *    indistinguishable from a missing order (404)
 *  - served from OUR database only — the browser never calls iPaymu
 *  - returns only the sanitized instruction fields (no merchant VA,
 *    no API key, no signature, no raw provider payload)
 *  - NEVER changes payment state: polling can not settle an order,
 *    the signed webhook remains the settlement authority
 */
export async function GET(
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
         * Ownership is resolved BEFORE any order data is read: the
         * session owner or a valid guest access token. Payment
         * instructions (VA / QRIS) must never leak to another caller —
         * a leaked VA could be paid by a third party to hijack the
         * order.
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

        const view = await loadPaymentView(
            orderId,
            access.userId
        );

        if (!view) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Order tidak ditemukan.",
                },
                { status: 404 }
            );
        }

        return NextResponse.json(
            {
                success: true,
                data: view,
            },
            {
                status: 200,
                headers: {
                    // Polling responses must never be cached.
                    "Cache-Control": "no-store",
                },
            }
        );
    } catch (error) {
        console.error(
            "PAYMENT STATUS (ORDER) ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal mengambil status pembayaran.",
            },
            { status: 500 }
        );
    }
}
