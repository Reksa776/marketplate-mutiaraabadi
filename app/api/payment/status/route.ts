import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeOrderRequest } from "@/lib/guest-order-access";
import { buildTikTokBrowserMatch } from "@/lib/analytics/tiktok-user-match";

/*
 * ==========================================
 * GET PAYMENT STATUS
 * ==========================================
 *
 * /api/payment/status?reference=PAY-CART-xxx
 *
 * Dipakai oleh halaman payment-finish untuk
 * polling status order sampai webhook
 * payment provider selesai memproses.
 */

export async function GET(
    request: NextRequest
) {
    try {
        const { searchParams } =
            new URL(request.url);

        const reference =
            searchParams.get("reference");

        if (!reference) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Payment reference wajib diisi.",
                },
                { status: 400 }
            );
        }

        /*
         * OWNERSHIP: the reference resolves to ONE order, so its
         * ownership is verified before any data is returned. Guests
         * present the access token cookie issued at checkout; a
         * reference alone is never sufficient.
         */
        const referenceOrder =
            await prisma.order.findUnique({
                where: { orderNumber: reference },
                select: { id: true },
            });

        if (!referenceOrder) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Order tidak ditemukan.",
                },
                { status: 404 }
            );
        }

        const access = await authorizeOrderRequest(
            request,
            referenceOrder.id
        );

        if (!access.ok) {
            return NextResponse.json(
                { success: false, message: access.message },
                { status: access.status }
            );
        }

        const order =
            await prisma.order.findFirst({
                where: {
                    orderNumber: reference,
                },

                select: {
                    id: true,
                    orderNumber: true,
                    status: true,
                    paymentStatus: true,
                    total: true,
                    /*
                     * Advanced Matching source. Hashed below and
                     * NEVER returned raw — the response carries only
                     * SHA-256 digests.
                     */
                    userId: true,
                    phone: true,
                    user: {
                        select: {
                            email: true,
                            phone: true,
                        },
                    },
                },
            });

        if (!order) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Order tidak ditemukan.",
                },
                { status: 404 }
            );
        }

        /*
         * Strip the raw identity columns and hand the client the
         * authoritative ORDER → USER digests instead. Ownership is
         * already enforced above (`userId: session.user.id`).
         */
        const {
            user,
            phone,
            userId,
            ...safeOrder
        } = order;

        const identity = buildTikTokBrowserMatch({
            email: user?.email,
            phone: user?.phone ?? phone,
            externalId: userId,
        });

        return NextResponse.json({
            success: true,
            data: {
                ...safeOrder,
                identity,
            },
        });
    } catch (error) {
        console.error(
            "PAYMENT STATUS ERROR:",
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