import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redactMengantarKey } from "@/lib/mengantar";
import {
    createShipmentForOrder,
    deleteMengantarShipmentForOrder,
} from "@/lib/mengantar/shipment";

export const dynamic = "force-dynamic";

type RouteContext = {
    params: Promise<{ id: string }>;
};

/*
 * POST /api/admin/orders/[id]/shipment
 *
 * Admin-only. Creates the Mengantar shipment for an order.
 *
 * Idempotent: a second call for an order that already has a provider
 * shipment id returns the existing state without calling Mengantar.
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
                        "Akses ditolak. Hanya admin yang dapat membuat shipment.",
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

        /*
         * Admin recovery is the ONLY path allowed to recreate an
         * intentionally DELETED shipment. The automatic worker never
         * passes `allowDeleted`.
         */
        const result = await createShipmentForOrder(orderId, {
            allowDeleted: true,
        });

        if (!result.ok) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        result.reason ??
                        "Gagal membuat shipment.",
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
                action: "SHIPMENT_CREATED",
                entityType: "Order",
                entityId: orderId,
                description: `Mengantar shipment for order ${orderId}: ${result.shipmentStatus}`,
                metadata: {
                    orderId,
                    shipmentStatus:
                        result.shipmentStatus ?? null,
                    shippingPaymentStatus:
                        result.shippingPaymentStatus ??
                        null,
                    batchId: result.batchId ?? null,
                },
            });
        } catch {
            /* audit failure is non-critical */
        }

        /*
         * Shipment notification — reuse the EXISTING notification
         * pipeline. Only fires on a real transition (a duplicate
         * click is a no-op and must not re-notify). Fire-and-forget.
         */
        if (result.changed && result.shipmentStatus) {
            try {
                const { onShipmentStatusChanged } =
                    await import(
                        "@/lib/notification/order-status-handler"
                    );
                await onShipmentStatusChanged(
                    orderId,
                    "NOT_CREATED",
                    result.shipmentStatus
                );
            } catch (notificationError) {
                console.error(
                    "ADMIN SHIPMENT NOTIFICATION ERROR:",
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
                batchId: result.batchId ?? null,
                shipmentId: result.shipmentId ?? null,
            },
        });
    } catch (error) {
        console.error(
            "ADMIN MENGANTAR SHIPMENT ERROR:",
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
                        : "Gagal membuat shipment.",
            },
            { status: 500 }
        );
    }
}

/*
 * DELETE /api/admin/orders/[id]/shipment
 *
 * Admin-only INTENTIONAL deletion of the local shipment/tracking.
 * Server-authoritative: clears provider ids/resi, sets
 * `shipmentStatus = "DELETED"` (persisted), invalidates any queued
 * ShipmentJob, and audits the action. Reconcile/cron and the worker
 * will NEVER auto-recreate; the admin can still recreate manually via
 * POST (the existing create flow). Order.paymentStatus is untouched.
 */
export async function DELETE(
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
                        "Akses ditolak. Hanya admin yang dapat menghapus shipment.",
                },
                { status: 403 }
            );
        }

        const { id } = await params;
        const orderId = Number(id);

        if (!Number.isInteger(orderId) || orderId <= 0) {
            return NextResponse.json(
                {
                    success: false,
                    message: "ID pesanan tidak valid.",
                },
                { status: 400 }
            );
        }

        const result =
            await deleteMengantarShipmentForOrder(
                orderId,
                session.user.id
            );

        if (!result.ok) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        result.reason ??
                        "Gagal menghapus shipment.",
                },
                { status: 400 }
            );
        }

        return NextResponse.json({
            success: true,
            data: {
                changed: result.changed,
                deleted: result.deleted ?? true,
                shipmentStatus:
                    result.shipmentStatus ?? "DELETED",
            },
        });
    } catch (error) {
        console.error(
            "ADMIN MENGANTAR SHIPMENT DELETE ERROR:",
            error instanceof Error
                ? redactMengantarKey(error.message)
                : error
        );

        return NextResponse.json(
            {
                success: false,
                message: "Gagal menghapus shipment.",
            },
            { status: 500 }
        );
    }
}

/*
 * GET returns the shipment state without mutating anything, so the
 * admin UI can poll it.
 */
export async function GET(
    _req: Request,
    { params }: RouteContext
) {
    const session = await auth();

    if (session?.user?.role !== "ADMIN") {
        return NextResponse.json(
            { success: false, message: "Akses ditolak." },
            { status: 403 }
        );
    }

    const { id } = await params;
    const orderId = Number(id);

    if (!Number.isInteger(orderId) || orderId <= 0) {
        return NextResponse.json(
            {
                success: false,
                message: "ID pesanan tidak valid.",
            },
            { status: 400 }
        );
    }

    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            shippingProvider: true,
            providerShipmentId: true,
            providerBatchId: true,
            providerCourier: true,
            shippingPaymentStatus: true,
            shipmentStatus: true,
            trackingNumber: true,
            codAmount: true,
            paymentMethod: true,
            paymentStatus: true,
            shippingCourier: true,
            shippingService: true,
            shippingCost: true,
            updatedAt: true,
            // Automatic-shipment outbox state (read-only, admin UI).
            shipmentJob: {
                select: {
                    status: true,
                    stage: true,
                    attempts: true,
                    lastError: true,
                    pickupDate: true,
                    pickupTime: true,
                },
            },
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

    return NextResponse.json({
        success: true,
        data: order,
    });
}
