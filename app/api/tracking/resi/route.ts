import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { getMengantarOrderByTracking } from "@/lib/mengantar";
import { isMengantarOrder } from "@/lib/mengantar/tracking";
import { getClientIp, rateLimiters } from "@/lib/rate-limit";
import {
    RESI_INVALID_MESSAGE,
    RESI_NOT_FOUND_MESSAGE,
    RESI_SERVICE_ERROR_MESSAGE,
    RESI_THROTTLED_MESSAGE,
    buildResiTrackingView,
    normalizeResi,
} from "@/lib/tracking/resi-lookup";

export const dynamic = "force-dynamic";

/*
 * ============================================================
 * GET /api/tracking/resi?resi=<nomor resi>
 * ============================================================
 *
 * The endpoint behind the public "Lacak Resi" box on `/lacak`, the page
 * the WhatsApp menu sends customers to. A customer needs NO login and NO
 * order number: a waybill is the tracking key, exactly as a courier's
 * own tracking page works.
 *
 * DATA SOURCE (no invented status, ever)
 * --------------------------------------
 *   1. The LOCAL order row is matched on `trackingNumber` — the resi
 *      this project itself handed to the customer. A resi that matches
 *      nothing is answered with ONE uniform "not found".
 *   2. shippingProvider === "MENGANTAR"  → `getMengantarOrderByTracking`
 *      (GET /order?tracking_id=, the SAME read-only integration the
 *      order pages and the WhatsApp bot already use).
 *   3. every other provider → the synchronized stored state only, plus
 *      an honest note that detailed history is not integrated for it.
 *   A provider failure NEVER becomes a status: the stored state is shown
 *   with a disclosure note (see lib/tracking/resi-lookup.ts).
 *
 * SECURITY / PRIVACY
 * ------------------
 *   - READ-ONLY by construction: the only database call is a findFirst,
 *     and no ShipmentJob, shipment, pickup or status is ever created or
 *     updated by this route.
 *   - The response carries SHIPMENT FACTS ONLY. Name, phone, e-mail,
 *     address, items, totals, COD amount, order id, order number, guest
 *     token, payment reference and the Mengantar API key are neither
 *     read into the view nor serialized (the view type has no field for
 *     any of them).
 *   - UNIFORM not-found: the answer for an unknown resi and for a resi
 *     that belongs to no shipment of ours is identical, so the route
 *     cannot be used to confirm that a resi (or a customer) exists.
 *   - Rate limited per client AND per resi (lib/rate-limit.ts), so it is
 *     neither a flood surface nor a waybill-guessing oracle.
 *   - `Cache-Control: no-store` on every response.
 * ============================================================
 */

/** The ONLY order columns this route reads. No PII is even selected. */
const ORDER_SELECT = {
    shippingProvider: true,
    providerCourier: true,
    shippingCourier: true,
    shippingService: true,
    trackingNumber: true,
    shipmentStatus: true,
} as const;

/**
 * Every response is uncacheable: a shared cache must never serve one
 * customer's shipment data (or a stale status) to the next visitor, and
 * the page itself always shows the latest state.
 */
const NO_STORE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
} as const;

function fail(
    message: string,
    status: number,
    extraHeaders: Record<string, string> = {}
) {
    return NextResponse.json(
        { success: false, message },
        {
            status,
            headers: { ...NO_STORE_HEADERS, ...extraHeaders },
        }
    );
}

export async function GET(request: Request) {
    /* ---- 1. Per-client volume limit (before any work) ---- */
    const clientLimit = rateLimiters.publicResiLookup(
        getClientIp(request)
    );

    if (!clientLimit.allowed) {
        return fail(RESI_THROTTLED_MESSAGE, 429, {
            "Retry-After": String(
                Math.ceil(clientLimit.retryAfterMs / 1000)
            ),
        });
    }

    /* ---- 2. Validate + normalize the input ---- */
    const resi = normalizeResi(
        new URL(request.url).searchParams.get("resi")
    );

    if (!resi) {
        return fail(RESI_INVALID_MESSAGE, 400);
    }

    /* ---- 3. Per-resi limit (bounds resi enumeration) ---- */
    const resiLimit = rateLimiters.publicResiLookupIdentity(resi);

    if (!resiLimit.allowed) {
        return fail(RESI_THROTTLED_MESSAGE, 429, {
            "Retry-After": String(
                Math.ceil(resiLimit.retryAfterMs / 1000)
            ),
        });
    }

    try {
        /* ---- 4. Which shipment is this? (read-only) ---- */
        const order = await prisma.order.findFirst({
            where: { trackingNumber: resi },
            select: ORDER_SELECT,
        });

        if (!order) {
            return fail(RESI_NOT_FOUND_MESSAGE, 404);
        }

        /*
         * ---- 5. Mengantar: the live, read-only provider read ----
         *
         * A failed or timed-out read is DISCLOSED, never papered over
         * with a guessed status.
         */
        if (isMengantarOrder(order.shippingProvider)) {
            let fetched = null;
            let providerFailed = false;

            if (order.trackingNumber) {
                try {
                    fetched = await getMengantarOrderByTracking(
                        order.trackingNumber
                    );
                } catch {
                    console.error(
                        "PUBLIC RESI TRACKING: provider read failed"
                    );

                    fetched = null;
                    providerFailed = true;
                }
            }

            const providerGone =
                fetched?.isDeleted === true;

            return NextResponse.json(
                {
                    success: true,
                    data: buildResiTrackingView({
                        waybill: resi,
                        order,
                        fetched,
                        providerFailed,
                        providerGone,
                    }),
                },
                { headers: NO_STORE_HEADERS }
            );
        }

        /*
         * ---- 6. Legacy / other provider ----
         *
         * This project integrates NO public detail lookup for it, so the
         * synchronized stored state is returned WITH a note saying the
         * detailed history is not available. Nothing is faked and no
         * un-integrated provider endpoint is called.
         */
        return NextResponse.json(
            {
                success: true,
                data: buildResiTrackingView({
                    waybill: resi,
                    order,
                    fetched: null,
                    localOnly: true,
                }),
            },
            { headers: NO_STORE_HEADERS }
        );
    } catch (error) {
        console.error(
            "PUBLIC RESI TRACKING ERROR:",
            error instanceof Error ? error.message : error
        );

        return fail(RESI_SERVICE_ERROR_MESSAGE, 503);
    }
}
