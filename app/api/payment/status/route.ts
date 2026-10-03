import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
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
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Silakan login terlebih dahulu.",
                },
                { status: 401 }
            );
        }

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

        const order =
            await prisma.order.findFirst({
                where: {
                    orderNumber: reference,
                    userId: session.user.id,
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