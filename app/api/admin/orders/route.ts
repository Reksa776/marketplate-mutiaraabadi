import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/* ==========================================
 * GET /api/admin/orders
 * ==========================================
 *
 * Query params:
 *   page   — page number (default 1)
 *   limit  — items per page (default 20, max 100)
 *   status — optional order status filter
 *   search — optional search by orderNumber/recipientName
 */

export async function GET(
    request: Request
) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        if (session.user.role !== "ADMIN") {
            return NextResponse.json(
                {
                    success: false,
                    message: "Forbidden.",
                },
                { status: 403 }
            );
        }

        const { searchParams } = new URL(
            request.url
        );

        // ==========================================
        // PARSE & VALIDATE PAGINATION
        // ==========================================

        const rawPage = Number(
            searchParams.get("page") ?? "1"
        );
        const rawLimit = Number(
            searchParams.get("limit") ?? "20"
        );

        const page =
            Number.isInteger(rawPage) &&
            rawPage > 0
                ? rawPage
                : 1;

        const limit = Math.min(
            100,
            Math.max(
                1,
                Number.isInteger(rawLimit) &&
                    rawLimit > 0
                    ? rawLimit
                    : 20
            )
        );

        const offset = (page - 1) * limit;

        // ==========================================
        // PARSE FILTERS
        // ==========================================

        const search =
            searchParams
                .get("search")
                ?.trim() || undefined;

        const statusParam =
            searchParams.get("status");

        const where: any = {};

        if (search) {
            where.OR = [
                {
                    orderNumber: {
                        contains: search,
                    },
                },
                {
                    recipientName: {
                        contains: search,
                    },
                },
            ];
        }

        if (statusParam) {
            where.status = statusParam;
        }

        // ==========================================
        // FETCH WITH PAGINATION
        // ==========================================

        const [orders, total] =
            await Promise.all([
                prisma.order.findMany({
                    where,
                    orderBy: {
                        createdAt: "desc",
                    },
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                phone: true,
                            },
                        },
                        items: true,
                    },
                    take: limit,
                    skip: offset,
                }),
                prisma.order.count({
                    where,
                }),
            ]);

        const data = orders.map((order) => ({
            id: order.id,

            orderNumber: order.orderNumber,

            recipientName:
                order.recipientName,
            phone: order.phone,

            address: order.address,
            city: order.city,
            district: order.district,
            province: order.province,
            postalCode: order.postalCode,

            subtotal: Number(order.subtotal),
            shippingCost: Number(
                order.shippingCost
            ),
            total: Number(order.total),

            status: order.status,
            paymentMethod:
                order.paymentMethod,
            paymentStatus:
                order.paymentStatus,

            shippingCourier:
                order.shippingCourier,

            shippingService:
                order.shippingService,

            // ---- Shipment fulfilment provider (Mengantar) ----
            // Exposed read-only so the list can render an accurate
            // "Status Mengantar" without a second request. These are
            // internal identifiers (never credentials), matching the
            // detail route's existing exposure.
            shippingProvider:
                order.shippingProvider,

            providerShipmentId:
                order.providerShipmentId,

            shipmentStatus:
                order.shipmentStatus,

            shippingPaymentStatus:
                order.shippingPaymentStatus,

            trackingNumber:
                order.trackingNumber,

            trackingUrl: order.trackingUrl,

            createdAt:
                order.createdAt.toISOString(),

            updatedAt:
                order.updatedAt.toISOString(),

            user: order.user
                ? {
                      id: order.user.id,
                      name:
                          order.user.name ??
                          order.recipientName,
                      email:
                          order.user.email ??
                          "-",
                      phone:
                          order.user.phone ??
                          order.phone,
                  }
                : null,

            items: order.items.map(
                (item) => ({
                    id: item.id,
                    productName:
                        item.productName,
                    variantName:
                        item.variantName,
                    quantity: item.quantity,
                    price: Number(item.price),
                    subtotal: Number(
                        item.subtotal
                    ),
                })
            ),
        }));

        return NextResponse.json({
            success: true,
            data: {
                items: data,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(
                        total / limit
                    ),
                },
            },
        });
    } catch (error) {
        console.error(
            "GET ADMIN ORDERS ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal mengambil pesanan admin.",
            },
            { status: 500 }
        );
    }
}
