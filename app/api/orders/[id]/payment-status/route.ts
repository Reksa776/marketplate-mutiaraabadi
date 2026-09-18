import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { loadPaymentView } from "@/lib/payment/order-payment";

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
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Silakan login terlebih dahulu.",
                },
                { status: 401 }
            );
        }

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

        const view = await loadPaymentView(
            orderId,
            session.user.id
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
