import { NextResponse } from "next/server";
import { cancelOwnPendingOrder } from "@/lib/checkout";
import { authorizeOrderRequest } from "@/lib/guest-order-access";

export async function POST(
    req: Request,
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
         * OWNERSHIP: session owner OR a valid guest access token.
         * Order ids are sequential, so they are never sufficient alone.
         */
        const access = await authorizeOrderRequest(
            req,
            orderId
        );

        if (!access.ok) {
            return NextResponse.json(
                { success: false, message: access.message },
                { status: access.status }
            );
        }

        /*
         * P0 FIX (C1):
         * Soft-cancel via atomic CAS state transition.
         * The order is NEVER deleted. rollbackCheckoutOrder
         * restores stock / flash-sale reservation / voucher
         * quota and cancels the affiliate commission inside
         * the same transaction.
         */
        const result = await cancelOwnPendingOrder(
            access.userId,
            orderId
        );

        if (!result.ok) {
            if (result.reason === "NOT_FOUND") {
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
                    success: false,
                    message:
                        "Order tidak dapat dibatalkan.",
                },
                { status: 400 }
            );
        }

        return NextResponse.json({
            success: true,
            message:
                "Order pembayaran dibatalkan.",
        });
    } catch (error) {
        console.error(
            "CANCEL ORDER ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal membatalkan order.",
            },
            { status: 500 }
        );
    }
}
