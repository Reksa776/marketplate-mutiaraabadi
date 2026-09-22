/* ==========================================
 * POST /api/admin/resi-scan/apply
 * ==========================================
 *
 * Applies admin-confirmed scan results to orders.
 *
 * Each item is applied in its OWN transaction and
 * re-validated server-side (order must exist, resi
 * format valid, no overwrite of an existing resi,
 * no reuse of a resi owned by another order,
 * order status allows tracking). A failure for one
 * item never blocks the others.
 *
 * Only MATCHED_READY (HIGH) items may be applied
 * without review; NEEDS_REVIEW items require the
 * admin to have sent them here (the UI only sends
 * them after explicit confirmation). The route does
 * not trust client-side "confidence" — the server
 * guards are enforced regardless.
 *
 * Writes an admin audit log entry per applied item.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
    applyScanResi,
} from "@/lib/resi-scan/apply";
import { isPlausibleTrackingNumber } from "@/lib/resi-scan/extract";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ITEMS = 50;

export async function POST(request: Request) {
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
                message:
                    "Akses ditolak. Hanya admin.",
            },
            { status: 403 }
        );
    }

    let body: {
        items?: Array<Record<string, unknown>>;
    };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json(
            {
                success: false,
                message: "Body JSON tidak valid.",
            },
            { status: 400 }
        );
    }

    const rawItems = Array.isArray(body.items)
        ? body.items
        : [];

    if (rawItems.length === 0) {
        return NextResponse.json(
            {
                success: false,
                message: "Tidak ada item untuk diterapkan.",
            },
            { status: 400 }
        );
    }

    if (rawItems.length > MAX_ITEMS) {
        return NextResponse.json(
            {
                success: false,
                message: `Maksimal ${MAX_ITEMS} item per permintaan.`,
            },
            { status: 400 }
        );
    }

    const items = rawItems.map((raw) => ({
        orderId: Number(raw.orderId) || 0,
        orderNumber:
            typeof raw.orderNumber === "string"
                ? raw.orderNumber.trim()
                : null,
        reference:
            typeof raw.reference === "string"
                ? raw.reference.trim()
                : null,
        trackingNumber:
            typeof raw.trackingNumber === "string"
                ? raw.trackingNumber.trim()
                : "",
        courier:
            typeof raw.courier === "string" &&
            raw.courier.trim()
                ? raw.courier.trim()
                : null,
        source: raw.source === "pdf-text" ||
            raw.source === "ocr"
                ? (raw.source as "pdf-text" | "ocr")
                : ("ocr" as const),
        confidence:
            typeof raw.confidence === "number"
                ? raw.confidence
                : 0,
        fileName:
            typeof raw.fileName === "string"
                ? raw.fileName
                : null,
    }));

    // Guard: only send valid-looking tracking values.
    for (const item of items) {
        if (!isPlausibleTrackingNumber(item.trackingNumber)) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Ada nomor resi yang formatnya tidak valid.",
                    data: {
                        trackingNumber:
                            item.trackingNumber,
                    },
                },
                { status: 400 }
            );
        }
    }

    const results = [];
    let applied = 0;
    let failed = 0;
    let skipped = 0;
    let conflicted = 0;

    for (const item of items) {
        const result = await applyScanResi(
            item,
            session.user.id
        );

        results.push(result);

        if (result.status === "APPLIED") {
            applied++;
        } else if (result.status === "ALREADY_SAME") {
            skipped++;
        } else if (result.status === "CONFLICT") {
            conflicted++;
        } else {
            failed++;
        }
    }

    return NextResponse.json({
        success: true,
        message: "Proses penerapan resi selesai.",
        data: {
            summary: {
                total: results.length,
                applied,
                skipped,
                conflicted,
                failed,
            },
            results,
        },
    });
}