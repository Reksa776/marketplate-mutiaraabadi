import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { releaseStockAndVoucherForOrder } from "@/lib/order-stock";
import { releaseShippingDiscountForOrder } from "@/lib/marketing/shipping-discount";
import { createAuditLog } from "@/lib/admin/audit-log";

type RouteContext = {
    params: Promise<{
        id: string;
    }>;
};

const allowedStatuses = [
    "PENDING",
    "PAID",
    "PROCESSING",
    "SHIPPED",
    "COMPLETED",
    "CANCELLED",
    "REFUND_PENDING",
];

/*
|--------------------------------------------------------------------------
| GET DETAIL ORDER ADMIN
|--------------------------------------------------------------------------
*/
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
                { status: 401 }
            );
        }

        if (session.user.role !== "ADMIN") {
            return NextResponse.json(
                {
                    success: false,
                    message: "Akses ditolak.",
                },
                { status: 403 }
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
                    message:
                        "ID pesanan tidak valid.",
                },
                { status: 400 }
            );
        }

        const order =
            await prisma.order.findUnique({
                where: {
                    id: orderId,
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
                { status: 404 }
            );
        }

        const data = {
            id: order.id,
            orderNumber: order.orderNumber,

            customer: order.user
                ? {
                      id: order.user.id,
                      name: order.user.name,
                      email: order.user.email,
                      phone: order.user.phone,
                  }
                : null,

            recipientName:
                order.recipientName,

            phone: order.phone,

            address: order.address,

            note: order.note,

            city: order.city,
            district: order.district,
            province: order.province,
            postalCode: order.postalCode,

            subtotal: Number(order.subtotal),
            shippingCost:
                Number(order.shippingCost),
            total: Number(order.total),

            status: order.status,

            paymentMethod:
                order.paymentMethod,

            paymentStatus:
                order.paymentStatus,

            paidAt: order.paidAt
                ? order.paidAt.toISOString()
                : null,

            shippingCourier:
                order.shippingCourier,

            shippingService:
                order.shippingService,

            trackingNumber:
                order.trackingNumber,

            trackingUrl:
                order.trackingUrl,

            // ---- Shipment fulfilment provider (Mengantar) ----
            shippingProvider:
                order.shippingProvider,

            providerCourier:
                order.providerCourier,

            providerShipmentId:
                order.providerShipmentId,

            providerBatchId:
                order.providerBatchId,

            shipmentStatus:
                order.shipmentStatus,

            shippingPaymentStatus:
                order.shippingPaymentStatus,

            codAmount: order.codAmount
                ? Number(order.codAmount)
                : null,

            createdAt:
                order.createdAt.toISOString(),

            updatedAt:
                order.updatedAt.toISOString(),

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

                    price: Number(
                        item.price
                    ),

                    quantity:
                        item.quantity,

                    subtotal: Number(
                        item.subtotal
                    ),

                    product:
                        item.product
                            ? {
                                  id:
                                      item
                                          .product
                                          .id,

                                  name:
                                      item
                                          .product
                                          .name,

                                  slug:
                                      item
                                          .product
                                          .slug,

                                  image:
                                      item
                                          .product
                                          .image,
                              }
                            : null,

                    variant:
                        item.variant
                            ? {
                                  id:
                                      item
                                          .variant
                                          .id,

                                  name:
                                      item
                                          .variant
                                          .name,

                                  image:
                                      item
                                          .variant
                                          .image,

                                  weight:
                                      item
                                          .variant
                                          .weight,
                              }
                            : null,
                })
            ),
        };

        return NextResponse.json({
            success: true,
            data,
        });
    } catch (error) {
        console.error(
            "GET ADMIN ORDER DETAIL ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal mengambil detail pesanan.",
            },
            { status: 500 }
        );
    }
}

/*
|--------------------------------------------------------------------------
| PATCH STATUS + RESI
|--------------------------------------------------------------------------
*/
export async function PATCH(
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
                { status: 401 }
            );
        }

        if (session.user.role !== "ADMIN") {
            return NextResponse.json(
                {
                    success: false,
                    message: "Akses ditolak.",
                },
                { status: 403 }
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
                    message:
                        "ID pesanan tidak valid.",
                },
                { status: 400 }
            );
        }

        const body = await req.json();

        const {
            status,
            trackingNumber,
        } = body;

        if (
            !status ||
            !allowedStatuses.includes(status)
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Status pesanan tidak valid.",
                },
                { status: 400 }
            );
        }

        const order =
            await prisma.order.findUnique({
                where: {
                    id: orderId,
                },
            });

        if (!order) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Pesanan tidak ditemukan.",
                },
                { status: 404 }
            );
        }

        const cleanTrackingNumber =
            typeof trackingNumber === "string"
                ? trackingNumber.trim()
                : "";

        /*
         * SHIPPED -> wajib ada resi
         */
        if (
            status === "SHIPPED" &&
            !cleanTrackingNumber &&
            !order.trackingNumber
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Nomor resi wajib diisi sebelum status menjadi Dikirim.",
                },
                { status: 400 }
            );
        }

        /*
         * COMPLETED -> wajib ada resi
         */
        if (
            status === "COMPLETED" &&
            !cleanTrackingNumber &&
            !order.trackingNumber
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Nomor resi belum tersedia.",
                },
                { status: 400 }
            );
        }

        let trackingUrl =
            order.trackingUrl;

        if (cleanTrackingNumber) {
            trackingUrl =
                createTrackingUrl(
                    order.shippingCourier,
                    cleanTrackingNumber
                );
        }

        if (
            trackingNumber === ""
        ) {
            trackingUrl = null;
        }

        /*
         * STATUS TRANSITION GUARD (T1-2 FIX):
         * Prevent invalid backward transitions.
         * Once PAID/COMPLETED/SHIPPED, cannot revert to PENDING.
         * Once CANCELLED, cannot change.
         */
        const validTransitions: Record<string, string[]> = {
            PENDING:          ["PAID", "PROCESSING", "CANCELLED"],
            PAID:             ["PROCESSING", "SHIPPED", "COMPLETED", "CANCELLED"],
            PROCESSING:       ["SHIPPED", "COMPLETED", "CANCELLED"],
            SHIPPED:          ["COMPLETED"],
            COMPLETED:        [],
            CANCELLED:        [],
            REFUND_PENDING:   ["CANCELLED"],
        };

        const allowed = validTransitions[order.status];

        if (!allowed || !allowed.includes(status)) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        `Transisi dari ${order.status} ke ${status} tidak diperbolehkan.`,
                },
                { status: 400 }
            );
        }

        const previousStatus = order.status;

        let conflict = false;

        const updatedOrder = await prisma.$transaction(async (tx) => {
            /*
             * P0 FIX (C3): CAS status update.
             *
             * When transitioning to CANCELLED, also restore stock,
             * release the shipping-discount usage, and cancel
             * affiliate commission inside the same transaction. The
             * stock release uses conditional updates (GREATEST,
             * saleStock >= qty) so duplicate calls are safe.
             */
            if (status === "CANCELLED" && previousStatus !== "CANCELLED") {
                // CAS: atomically set status to CANCELLED
                const casAffected = await tx.$executeRaw`
                    UPDATE \`order\`
                    SET status = 'CANCELLED'
                    WHERE id = ${orderId}
                      AND status != 'CANCELLED'
                `;

                if (casAffected === 0) {
                    // Already cancelled — report conflict (state changed
                    // between read and write).
                    conflict = true;
                    return null;
                }

                // Release reserved stock and voucher usage
                await releaseStockAndVoucherForOrder(tx, orderId);

                // Release the reserved shipping-discount usage (F9/F21)
                if (order.shippingDiscountId) {
                    await releaseShippingDiscountForOrder(
                        tx,
                        order
                    );
                }

                // Cancel affiliate commission
                const { cancelCommissionForOrder } =
                    await import("@/lib/affiliate/cancel-commission");
                await cancelCommissionForOrder(tx, orderId, "ADMIN_CANCELLED");

                return await tx.order.findUnique({ where: { id: orderId } });
            }

            /*
             * F21/TOCTOU FIX: every non-cancel transition is a
             * compare-and-swap against the status we validated above.
             * Two concurrent PATCHes that both read `previousStatus`
             * can no longer both apply (e.g. PAID -> PROCESSING and
             * PAID -> SHIPPED landing simultaneously, skipping valid
             * intermediate states).
             */
            const casAffected = await tx.$executeRaw`
                UPDATE \`order\`
                SET status = ${status},
                    trackingNumber = ${
                        trackingNumber !== undefined
                            ? cleanTrackingNumber || null
                            : order.trackingNumber
                    },
                    trackingUrl = ${trackingUrl}
                WHERE id = ${orderId}
                  AND status = ${previousStatus}
            `;

            if (casAffected === 0) {
                conflict = true;
                return null;
            }

            const updated = await tx.order.findUnique({
                where: { id: orderId },
            });

            /*
             * AFFILIATE COMMISSION AUTO-APPROVAL:
             * When order reaches COMPLETED, approve
             * the associated PENDING commission.
             */
            if (status === "COMPLETED") {
                const { approveCommissionForOrder } =
                    await import("@/lib/affiliate/approve-commission");
                await approveCommissionForOrder(
                    tx,
                    orderId,
                    "ORDER_COMPLETED"
                );
            }

            return updated;
        });

        if (conflict) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Status pesanan telah berubah oleh permintaan lain. Silakan muat ulang dan coba lagi.",
                },
                { status: 409 }
            );
        }

        /*
         * ==========================================
         * AUDIT LOG
         * ==========================================
         *
         * Record admin order status change for
         * accountability and incident investigation.
         */
        if (previousStatus !== status) {
            const auditAction = status === "CANCELLED"
                ? "ORDER_CANCELLED"
                : "ORDER_STATUS_CHANGED";

            createAuditLog({
                adminId: session.user.id,
                action: auditAction,
                entityType: "Order",
                entityId: orderId,
                description: `Order #${orderId}: ${previousStatus} → ${status}`,
                metadata: {
                    orderNumber: updatedOrder?.orderNumber || null,
                    previousStatus,
                    newStatus: status,
                    trackingNumber: cleanTrackingNumber || null,
                },
            }).catch((err) =>
                console.error("AUDIT LOG ERROR:", err)
            );
        }

        /*
         * ==========================================
         * NOTIFICATION TRIGGER
         * ==========================================
         *
         * Fire-and-forget.
         * Notification error tidak boleh
         * mempengaruhi response ke admin.
         */
        if (previousStatus !== status) {
            const { onOrderStatusChanged } =
                await import(
                    "@/lib/notification/order-status-handler"
                );

            onOrderStatusChanged(
                orderId,
                previousStatus,
                status
            ).catch((err) =>
                console.error(
                    "NOTIFICATION TRIGGER ERROR:",
                    err
                )
            );
        }        if (!updatedOrder) {
            return NextResponse.json(
                { success: false, message: "Pesanan tidak ditemukan." },
                { status: 404 }
            );
        }

        return NextResponse.json({
            success: true,
            message: "Pesanan berhasil diperbarui.",
            data: {
                id: updatedOrder.id,
                orderNumber: updatedOrder.orderNumber,
                status: updatedOrder.status,
                shippingCourier: updatedOrder.shippingCourier,
                shippingService: updatedOrder.shippingService,
                trackingNumber: updatedOrder.trackingNumber,
                trackingUrl: updatedOrder.trackingUrl,
            },
        });
    } catch (error) {
        console.error(
            "UPDATE ADMIN ORDER ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal memperbarui pesanan.",
            },
            { status: 500 }
        );
    }
}

/*
|--------------------------------------------------------------------------
| FALLBACK TRACKING URL
|--------------------------------------------------------------------------
*/
function createTrackingUrl(
    courier: string | null,
    trackingNumber: string
) {
    const normalizedCourier =
        courier
            ?.toLowerCase()
            .trim();

    switch (normalizedCourier) {
        case "jne":
            return `https://www.jne.co.id/id/tracking/trace/tracking?awb=${encodeURIComponent(
                trackingNumber
            )}`;

        case "jnt":
        case "j&t":
        case "jnt_express":
            return `https://www.jet.co.id/track?awb=${encodeURIComponent(
                trackingNumber
            )}`;

        case "sicepat":
            return `https://www.sicepat.com/checkAwb?awb=${encodeURIComponent(
                trackingNumber
            )}`;

        case "anteraja":
            return `https://anteraja.id/tracking?tracking_number=${encodeURIComponent(
                trackingNumber
            )}`;

        case "pos":
        case "pos_indonesia":
            return `https://www.posindonesia.co.id/id/tracking?code=${encodeURIComponent(
                trackingNumber
            )}`;

        default:
            return null;
    }
}