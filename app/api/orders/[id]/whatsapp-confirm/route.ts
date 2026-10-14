import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { authorizeOrderRequest } from "@/lib/guest-order-access";
import { resolveAdminWhatsAppTarget } from "@/lib/whatsapp/admin-number";
import {
    buildWhatsAppConfirmUrl,
    buildWhatsAppProblemUrl,
    getOrderConfirmStatusLabel,
} from "@/lib/whatsapp/order-confirm";

export const dynamic = "force-dynamic";

/* ==========================================
 * GET /api/orders/[id]/whatsapp-confirm
 * ==========================================
 *
 * Read-only. Returns the `wa.me` link the customer taps to open a chat
 * with the ADMIN's WhatsApp number (the account connected by QR in the
 * dashboard), pre-filled with this order's number, name and status.
 *
 * SECURITY
 *  - ownership is resolved BEFORE the order is read: the session owner
 *    or the guest access token cookie for THIS order. Another customer's
 *    order is indistinguishable from a missing one (404), so the
 *    sequential order id is not an enumeration oracle.
 *  - the destination number is taken ONLY from the connected session.
 *    The sole query value read is `intent`, a fixed two-value enum that
 *    only swaps the pre-filled DRAFT (`problem` = report a problem with
 *    this order, anything else = the confirmation draft). A caller
 *    therefore still cannot point the link at an arbitrary number.
 *  - only orderNumber / recipientName / status are selected, so no guest
 *    access token, OTP, email, phone, address or payment reference can
 *    reach the URL.
 *  - NOTHING is written: no order status change, no second order, no
 *    WhatsApp message. Tapping the button is a pure navigation the
 *    customer performs in their own WhatsApp app.
 *  - when the session is down or the account number is unusable the
 *    response says so with `url: null`; the client must NOT fabricate a
 *    link.
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
         * `intent` is an enum, never a destination and never customer
         * text: an unknown or hostile value falls back to the
         * confirmation draft.
         */
        const intent =
            new URL(request.url).searchParams.get("intent") ===
            "problem"
                ? "problem"
                : "confirm";

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

        /*
         * Deliberately narrow projection — this endpoint exists to build
         * a PUBLIC url, so anything selected here could leak into it.
         */
        const order = await prisma.order.findFirst({
            where: {
                id: orderId,
            },
            select: {
                id: true,
                orderNumber: true,
                recipientName: true,
                status: true,
            },
        });

        if (!order) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Pesanan tidak ditemukan.",
                },
                { status: 404 }
            );
        }

        const target = await resolveAdminWhatsAppTarget();

        const noStoreHeaders = {
            "Cache-Control": "no-store",
        };

        if (!target.available) {
            return NextResponse.json(
                {
                    success: true,
                    data: {
                        available: false,
                        reason: target.reason,
                        url: null,
                    },
                },
                {
                    status: 200,
                    headers: noStoreHeaders,
                }
            );
        }

        const url =
            intent === "problem"
                ? /*
                   * Minimal draft: the customer asked for help with a
                   * problem, so only the order number is pre-filled.
                   */
                  buildWhatsAppProblemUrl({
                      adminPhoneNumber: target.phoneNumber,
                      orderNumber: order.orderNumber,
                  })
                : buildWhatsAppConfirmUrl({
                      adminPhoneNumber: target.phoneNumber,
                      orderNumber: order.orderNumber,
                      customerName: order.recipientName,
                      statusLabel: getOrderConfirmStatusLabel(
                          order.status
                      ),
                  });

        /*
         * The resolver already validated the number, so a null here is
         * defensive: still answer "unavailable" rather than a broken
         * link.
         */
        if (!url) {
            return NextResponse.json(
                {
                    success: true,
                    data: {
                        available: false,
                        reason: "NO_NUMBER",
                        url: null,
                    },
                },
                {
                    status: 200,
                    headers: noStoreHeaders,
                }
            );
        }

        return NextResponse.json(
            {
                success: true,
                data: {
                    available: true,
                    url,
                },
            },
            {
                status: 200,
                headers: noStoreHeaders,
            }
        );
    } catch (error) {
        console.error(
            "WHATSAPP CONFIRM (ORDER) ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal menyiapkan konfirmasi WhatsApp.",
            },
            { status: 500 }
        );
    }
}
