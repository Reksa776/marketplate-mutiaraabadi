import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";

type Order = {
    id: number;
    orderNumber: string;

    recipientName: string;
    phone: string;
    address: string;

    note: string | null;

    city: string | null;
    district: string | null;
    province: string | null;
    postalCode: string | null;

    latitude: number | null;
    longitude: number | null;

    shippingCourier: string | null;
    shippingService: string | null;

    trackingNumber: string | null;
    trackingUrl: string | null;

    /*
     * Mengantar shipment state. Read-only, already persisted — the
     * customer UI can render "dibuat otomatis", the courier and the
     * latest shipment status even BEFORE a resi exists, without any
     * admin input. providerShipmentId / providerBatchId stay private.
     */
    shippingProvider: string | null;
    providerCourier: string | null;
    shipmentStatus: string | null;

    subtotal: number;
    shippingCost: number;
    total: number;

    status: string;
    paymentMethod: string;
    paymentStatus: string;

    paidAt: string | null;

    createdAt: string;
    updatedAt: string;

};

type RouteContext = {
    params: Promise<{
        id: string;
    }>;
};

export async function GET(
    req: Request,
    { params }: RouteContext
) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                {
                    status: 401,
                }
            );
        }

        const { id } = await params;

        const orderId = Number(id);

        if (
            !Number.isInteger(orderId) ||
            orderId <= 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "ID pesanan tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        const order =
            await prisma.order.findFirst({
                where: {
                    id: orderId,
                    userId: session.user.id,
                },

                include: {
                    items: {
                        orderBy: {
                            id: "asc",
                        },

                        select: {
                            id: true,
                            productId: true,
                            variantId: true,

                            productName: true,
                            variantName: true,

                            price: true,
                            quantity: true,
                            subtotal: true,

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
                                    weight: true,
                                },
                            },
                        },
                    },
                },
            });

        if (!order) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Pesanan tidak ditemukan.",
                },
                {
                    status: 404,
                }
            );
        }

        const responseData = {
            id: order.id,

            orderNumber:
                order.orderNumber,

            recipientName:
                order.recipientName,

            phone:
                order.phone,

            address:
                order.address,

            note:
                order.note,

            city:
                order.city,

            district:
                order.district,

            province:
                order.province,

            postalCode:
                order.postalCode,

            latitude:
                order.latitude
                    ? Number(order.latitude)
                    : null,

            longitude:
                order.longitude
                    ? Number(order.longitude)
                    : null,

            /*
             * ===============================
             * SHIPPING
             * ===============================
             */

            shippingCourier:
                order.shippingCourier,

            shippingService:
                order.shippingService,

            trackingNumber:
                order.trackingNumber,

            trackingUrl:
                order.trackingUrl,

            /*
             * Mengantar shipment state (read-only). Never provider
             * identifiers, never credentials.
             */
            shippingProvider:
                order.shippingProvider,

            providerCourier:
                order.providerCourier,

            shipmentStatus:
                order.shipmentStatus,

            /*
             * ===============================
             * PAYMENT
             * ===============================
             */

            subtotal:
                Number(order.subtotal),

            shippingCost:
                Number(order.shippingCost),

            total:
                Number(order.total),

            status:
                order.status,

            paymentMethod:
                order.paymentMethod,

            paymentStatus:
                order.paymentStatus,

            paidAt:
                order.paidAt
                    ? order.paidAt.toISOString()
                    : null,

            /*
             * ===============================
             * DATE
             * ===============================
             */

            createdAt:
                order.createdAt.toISOString(),

            updatedAt:
                order.updatedAt.toISOString(),

            /*
             * ===============================
             * ITEMS
             * ===============================
             */

            items: order.items.map(
                (item) => ({
                    id: item.id,

                    productId:
                        item.productId,

                    variantId:
                        item.variantId,

                    productName:
                        item.productName,

                    variantName:
                        item.variantName,

                    price:
                        Number(item.price),

                    quantity:
                        item.quantity,

                    subtotal:
                        Number(item.subtotal),

                    product:
                        item.product
                            ? {
                                id:
                                    item.product.id,

                                name:
                                    item.product.name,

                                slug:
                                    item.product.slug,

                                image:
                                    item.product.image,
                            }
                            : null,

                    variant:
                        item.variant
                            ? {
                                id:
                                    item.variant.id,

                                name:
                                    item.variant.name,

                                image:
                                    item.variant.image,

                                weight:
                                    item.variant.weight,
                            }
                            : null,
                })
            ),
        };

        return NextResponse.json({
            success: true,
            data: responseData,
        });
    } catch (error) {
        console.error(
            "GET ORDER DETAIL ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal mengambil detail pesanan.",
            },
            {
                status: 500,
            }
        );
    }
}