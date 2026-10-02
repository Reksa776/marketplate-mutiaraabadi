import crypto from "crypto";
import { NextResponse } from "next/server";

import { reconcileMengantarShipments } from "@/lib/mengantar/reconcile";
import { processShipmentJobs } from "@/lib/mengantar/shipment-worker";

export const dynamic = "force-dynamic";

/*
 * ============================================================
 * GET|POST /api/cron/shipment-reconcile
 * ============================================================
 *
 * External-scheduler entry point (the project has NO in-process
 * cron/timer infrastructure). Point a system cron / uptime scheduler
 * at this route every few minutes:
 *
 *   Authorization: Bearer <CRON_SECRET>
 *   (or) x-cron-secret: <CRON_SECRET>
 *
 * It runs the self-healing reconciliation pass — provider-verifying
 * locally-CREATED Mengantar shipments and resetting only the ones
 * the provider authoritatively confirms are gone — then drains the
 * durable ShipmentJob outbox.
 *
 * SECURITY:
 *   - FAIL CLOSED: when CRON_SECRET is unset the route answers 503
 *     and does nothing.
 *   - Constant-time comparison; the secret is never logged or
 *     returned.
 *   - Read-only against Mengantar (GET); this route never POSTs a
 *     shipment itself — the worker does, behind its CAS claim.
 * ============================================================
 */

function unauthorized() {
    return NextResponse.json(
        { success: false, message: "Unauthorized." },
        { status: 401 }
    );
}

function timingSafeEqual(
    a: string,
    b: string
): boolean {
    const bufferA = Buffer.from(a, "utf8");
    const bufferB = Buffer.from(b, "utf8");

    if (bufferA.length !== bufferB.length) {
        return false;
    }

    return crypto.timingSafeEqual(bufferA, bufferB);
}

function isAuthorized(request: Request): boolean {
    const secret = process.env.CRON_SECRET;

    if (!secret) return false;

    const header =
        request.headers.get("authorization") ?? "";

    const bearer = header
        .toLowerCase()
        .startsWith("bearer ")
        ? header.slice(7).trim()
        : "";

    const provided =
        bearer ||
        (request.headers.get("x-cron-secret") ?? "").trim();

    if (!provided) return false;

    return timingSafeEqual(provided, secret);
}

async function handle(request: Request) {
    if (!process.env.CRON_SECRET) {
        return NextResponse.json(
            {
                success: false,
                message: "Cron belum dikonfigurasi.",
            },
            { status: 503 }
        );
    }

    if (!isAuthorized(request)) {
        return unauthorized();
    }

    try {
        const reconcile = await reconcileMengantarShipments({
            limit: 25,
        });

        const jobs = await processShipmentJobs({ limit: 50 });

        return NextResponse.json({
            success: true,
            data: {
                scanned: reconcile.scanned,
                reconciled: reconcile.reconciled,
                processed: jobs.processed,
            },
        });
    } catch (error) {
        console.error(
            "SHIPMENT RECONCILE CRON ERROR:",
            error instanceof Error ? error.message : error
        );

        return NextResponse.json(
            {
                success: false,
                message: "Gagal menjalankan reconciliation.",
            },
            { status: 500 }
        );
    }
}

export async function GET(request: Request) {
    return handle(request);
}

export async function POST(request: Request) {
    return handle(request);
}
