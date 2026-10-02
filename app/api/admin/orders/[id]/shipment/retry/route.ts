import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { redactMengantarKey } from "@/lib/mengantar";
import { runShipmentJobForOrder } from "@/lib/mengantar/shipment-worker";

export const dynamic = "force-dynamic";

type RouteContext = {
    params: Promise<{ id: string }>;
};

/*
 * POST /api/admin/orders/[id]/shipment/retry
 *
 * ADMIN-only manual recovery. Resets the durable ShipmentJob for this
 * order and processes it immediately (create or pay-unpaid, depending
 * on the stage). This is the "genuinely needed" admin fallback — the
 * normal path is fully automatic.
 *
 * Idempotent: the underlying create/pay calls are CAS-guarded, and
 * the job claim prevents concurrent double-processing.
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
                    message: "Akses ditolak.",
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

        const result = await runShipmentJobForOrder(orderId);

        if (!result.ok) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        result.reason ??
                        "Gagal memproses shipment.",
                },
                { status: 400 }
            );
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error(
            "ADMIN SHIPMENT RETRY ERROR:",
            error instanceof Error
                ? redactMengantarKey(error.message)
                : error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? redactMengantarKey(error.message)
                        : "Gagal memproses shipment.",
            },
            { status: 500 }
        );
    }
}
