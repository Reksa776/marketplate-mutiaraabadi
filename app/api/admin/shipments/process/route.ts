import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { processShipmentJobs } from "@/lib/mengantar/shipment-worker";
import { reconcileMengantarShipments } from "@/lib/mengantar/reconcile";

export const dynamic = "force-dynamic";

/*
 * POST /api/admin/shipments/process
 *
 * ADMIN-only sweeper for the durable ShipmentJob outbox. Processes
 * every currently-due job (retry/backoff aware). Intended to be
 * called by an external cron / scheduler, or manually by an admin
 * from the order detail page.
 *
 * Idempotent and concurrency-safe: jobs are claimed via an atomic CAS,
 * so calling this repeatedly (or concurrently) can never create a
 * duplicate Mengantar shipment.
 *
 * NEVER touches Order.paymentStatus.
 */
export async function POST() {
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

        /*
         * Self-healing pass first: provider-verify locally-CREATED
         * Mengantar shipments and reset the ones the provider
         * authoritatively confirms are gone, then drain the outbox
         * so the recovered orders are re-created immediately.
         */
        const reconcile = await reconcileMengantarShipments({
            limit: 25,
        });

        const result = await processShipmentJobs({ limit: 50 });

        return NextResponse.json({
            success: true,
            data: {
                processed: result.processed,
                scanned: reconcile.scanned,
                reconciled: reconcile.reconciled,
            },
        });
    } catch (error) {
        console.error(
            "ADMIN SHIPMENT SWEEP ERROR:",
            error instanceof Error ? error.message : error
        );

        return NextResponse.json(
            {
                success: false,
                message: "Gagal memproses job shipment.",
            },
            { status: 500 }
        );
    }
}
