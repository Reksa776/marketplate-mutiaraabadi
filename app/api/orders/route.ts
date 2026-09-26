import {
    NextRequest,
    NextResponse,
} from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

import {
    createCheckoutOrder,
    getShippingCost,
} from "@/lib/checkout";

import { getReferralCode } from "@/lib/affiliate/referral";

import { rateLimiters } from "@/lib/rate-limit";
import { readOrderAttribution } from "@/lib/analytics/attribution-server";

/*
 * ==========================================
 * POST /api/orders
 * ==========================================
 *
 * COD ONLY
 *
 * Flow:
 *
 * validate
 * ↓
 * create order
 * ↓
 * reserve stock
 * ↓
 * clear cart
 */

export async function POST(
    request: NextRequest
) {
    try {
        /*
         * ==========================================
         * AUTH
         * ==========================================
         */

        const session =
            await auth();

        if (
            !session?.user?.id
        ) {
            return NextResponse.json(
                {
                    success: false,

                    message:
                        "Silakan login terlebih dahulu.",
                },
                {
                    status: 401,
                }
            );
        }

        const userId =
            session.user.id;

        /*
         * ==========================================
         * RATE LIMIT
         * ==========================================
         */

        const rateLimit =
            rateLimiters.orderCreation(userId);

        if (!rateLimit.allowed) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Terlalu banyak permintaan. Coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        /*
         * ==========================================
         * BODY
         * ==========================================
         */

        const body =
            await request.json();

        const {
            addressId,
            shipping,
            paymentMethod,
            voucherCode,
            spinWheelSpinId,
            selectedCartItemIds,
        } = body;

        /*
         * ==========================================
         * COD ONLY
         * ==========================================
         */

        if (
            paymentMethod !==
            "COD"
        ) {
            return NextResponse.json(
                {
                    success: false,

                    message:
                        "Pembayaran non-COD harus melalui API iPaymu.",
                },
                {
                    status: 400,
                }
            );
        }

        /*
         * ==========================================
         * ADDRESS
         * ==========================================
         */

        if (
            typeof addressId !==
                "string" ||
            !addressId.trim()
        ) {
            return NextResponse.json(
                {
                    success: false,

                    message:
                        "Alamat pengiriman wajib dipilih.",
                },
                {
                    status: 400,
                }
            );
        }

        /*
         * ==========================================
         * SHIPPING
         * ==========================================
         */

        if (
            !shipping ||
            typeof shipping !==
                "object"
        ) {
            return NextResponse.json(
                {
                    success: false,

                    message:
                        "Layanan pengiriman wajib dipilih.",
                },
                {
                    status: 400,
                }
            );
        }

        const shippingCost =
            getShippingCost(
                shipping
            );

        if (
            !Number.isFinite(
                shippingCost
            )
        ) {
            return NextResponse.json(
                {
                    success: false,

                    message:
                        "Biaya pengiriman tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        /*
         * ==========================================
         * CREATE COD ORDER
         * ==========================================
         */

        const affiliateCode =
            getReferralCode(
                request.headers.get("cookie")
            );

        const result =
            await createCheckoutOrder(
                {
                    userId,

                    mode:
                        "CART",

                    addressId,

                    shipping,

                    paymentMethod:
                        "COD",

                    voucherCode:
                        typeof voucherCode ===
                        "string"
                            ? voucherCode
                            : null,

                    affiliateCode,

                    spinWheelSpinId: typeof spinWheelSpinId === "number" ? spinWheelSpinId : null,

                    attribution: readOrderAttribution(request),

                    selectedCartItemIds: Array.isArray(selectedCartItemIds)
                        ? selectedCartItemIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
                        : undefined,
                }
            );

        return NextResponse.json(
            {
                success: true,

                message:
                    "Pesanan berhasil dibuat.",

                data: {
                    ...result.order,

                    subtotal:
                        result.subtotal,

                    shippingCost:
                        result.shippingCost,

                    discount:
                        result.discount,

                    total:
                        result.grossAmount,
                },
            },
            {
                status: 201,
            }
        );
    } catch (error: any) {
        console.error(
            JSON.stringify({
                event: "CHECKOUT_FAILURE",
                checkoutType: "CART_COD",
                message: error?.message ?? "Unknown error",
                timestamp: new Date().toISOString(),
            })
        );

        const status =
            Number.isInteger(
                error?.status
            )
                ? error.status
                : 500;

        return NextResponse.json(
            {
                success: false,

                message:
                    "Gagal membuat pesanan.",
            },
            {
                status,
            }
        );
    }
}

/*
 * ==========================================
 * GET /api/orders
 * ==========================================
 */

export async function GET() {
    try {
        const session =
            await auth();

        if (
            !session?.user?.id
        ) {
            return NextResponse.json(
                {
                    success: false,

                    message:
                        "Unauthorized.",
                },
                {
                    status: 401,
                }
            );
        }

        const orders =
            await prisma.order.findMany(
                {
                    where: {
                        userId:
                            session.user.id,
                    },

                    orderBy: {
                        createdAt:
                            "desc",
                    },

                    include: {
                        voucher: {
                            select: {
                                id: true,
                                code: true,
                                type: true,
                                value: true,
                            },
                        },

                        items: {
                            take: 1,

                            include: {
                                product: {
                                    select: {
                                        id: true,
                                        name: true,
                                        slug: true,
                                        image: true,
                                    },
                                },

                                variant: {
                                    select: {
                                        id: true,
                                        name: true,
                                        image: true,
                                    },
                                },
                            },
                        },
                    },
                }
            );

        return NextResponse.json(
            {
                success: true,

                data:
                    orders,
            }
        );
    } catch (error) {
        console.error(
            "GET CUSTOMER ORDERS ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,

                message:
                    "Gagal mengambil pesanan.",
            },
            {
                status: 500,
            }
        );
    }
}