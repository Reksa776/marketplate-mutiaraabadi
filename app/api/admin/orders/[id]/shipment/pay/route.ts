import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { redactMengantarKey } from "@/lib/mengantar";
import { payUnpaidShipmentForOrder } from "@/lib/mengantar/shipment";

export const dynamic = "force-dynamic";

type RouteContext = {
    params: Promise<{ id: string }>;
};

/*
 * POST /api/admin/orders/[id]/shipment/pay
 *
 * Admin-only. Pays an unpaid (balance-insufficient) NON-COD Mengantar
 * shipment from the seller's Mengantar balance via /order/pay-unpaid.
 * Completing the payment generates the tracking number (cnote_no).
 *
 * NEVER changes the marketplace paymentStatus.
 */
export async function POST(
    _req: Request,
    { params }: RouteContext
) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                { success: false, message: "Unauthorized." },
                { status: 401 }
            );
        }

        if (session.user.role !== "ADMIN") {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Akses ditolak. Hanya admin yang dapat membayar ongkir.",
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
                    message: "ID pesanan tidak valid.",
                },
                { status: 400 }
            );
        }

        const result =
            await payUnpaidShipmentForOrder(orderId);

        if (!result.ok) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        result.reason ??
                        "Gagal membayar ongkir.",
                },
                { status: 400 }
            );
        }

        try {
            const { createAuditLog } = await import(
                "@/lib/admin/audit-log"
            );
            await createAuditLog({
                adminId: session.user.id,
                action: "SHIPMENT_PAID",
                entityType: "Order",
                entityId: orderId,
                description: `Mengantar shipping paid for order ${orderId}`,
                metadata: {
                    orderId,
                    batchId: result.batchId ?? null,
                    shipmentStatus:
                        result.shipmentStatus ?? null,
                },
            });
        } catch {
            /* audit failure is non-critical */
        }

        // Reuse the existing notification pipeline; only real
        // transitions notify (a duplicate pay is a no-op).
        if (result.changed && result.shipmentStatus) {
            try {
                const { onShipmentStatusChanged } =
                    await import(
                        "@/lib/notification/order-status-handler"
                    );
                await onShipmentStatusChanged(
                    orderId,
                    "WAITING_SHIPPING_PAYMENT",
                    result.shipmentStatus
                );
            } catch (notificationError) {
                console.error(
                    "ADMIN SHIPMENT PAY NOTIFICATION ERROR:",
                    notificationError
                );
            }
        }

        return NextResponse.json({
            success: true,
            data: {
                changed: result.changed ?? false,
                shipmentStatus: result.shipmentStatus,
                shippingPaymentStatus:
                    result.shippingPaymentStatus,
                trackingNumber:
                    result.trackingNumber ?? null,
            },
        });
    } catch (error) {
        console.error(
            "ADMIN MENGANTAR PAY SHIPMENT ERROR:",
            error instanceof Error
                ? redactMengantarKey(error.message)
                : error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? redactMengantarKey(
                              error.message
                          )
                        : "Gagal membayar ongkir.",
            },
            { status: 500 }
        );
    }
}
