import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
    redactMengantarKey,
    toInternalCourier,
    verifyMengantarWebhookSignature,
} from "@/lib/mengantar";
import { decideMengantarShipmentTransition } from "@/lib/mengantar/status";

export const dynamic = "force-dynamic";

/*
 * ============================================================
 * POST /api/mengantar/webhook
 * ============================================================
 *
 * Mengantar pushes { cnote_no, order_id, courier, status_category }
 * whenever a shipment status changes.
 *
 * Flow:
 *   webhook → authenticate (HMAC) → parse → find order
 *           → idempotency + out-of-order guard → CAS update
 *           → notification
 *
 * SECURITY / CORRECTNESS:
 *   - HMAC-SHA256 signature verified over `x-timestamp + "." + raw
 *     body` with MENGANTAR_WEBHOOK_SECRET. FAIL-CLOSED, constant-time.
 *   - The secret / raw body are never logged.
 *   - Idempotent + out-of-order safe: the webhook may be retried and
 *     events may arrive out of order. Backwards transitions are
 *     rejected; terminal states are preserved.
 *   - NEVER changes the marketplace paymentStatus. A shipment
 *     DELIVERED event does not mean the CUSTOMER paid; a COD
 *     refusal/return does NOT trigger an automatic refund.
 *   - Unknown shipment → acknowledged (200) without touching any
 *     order, so Mengantar stops retrying.
 * ============================================================
 */

export async function POST(request: Request) {
    try {
        // Raw body MUST be read before any parsing — the signature
        // covers the exact bytes sent by Mengantar.
        const rawBody = await request.text();

        const timestamp =
            request.headers.get("x-timestamp") ?? "";
        const signature =
            request.headers.get("x-signature") ?? "";

        if (
            !verifyMengantarWebhookSignature({
                rawBody,
                timestamp,
                signature,
            })
        ) {
            console.error(
                "MENGANTAR WEBHOOK: invalid or missing signature — rejected"
            );

            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid signature.",
                },
                { status: 401 }
            );
        }

        let payload: {
            cnote_no?: unknown;
            order_id?: unknown;
            courier?: unknown;
            status_category?: unknown;
        };

        try {
            payload = JSON.parse(rawBody);
        } catch {
            return NextResponse.json(
                {
                    success: false,
                    message: "Body request tidak valid.",
                },
                { status: 400 }
            );
        }

        const trackingNumber = String(
            payload.cnote_no ?? ""
        ).trim();
        const providerShipmentId = String(
            payload.order_id ?? ""
        ).trim();
        const courierName = String(
            payload.courier ?? ""
        ).trim();
        const statusCategory = String(
            payload.status_category ?? ""
        ).trim();

        if (!trackingNumber && !providerShipmentId) {
            return NextResponse.json({
                success: true,
                message: "Ignored.",
            });
        }

        const order = await prisma.order.findFirst({
            where: {
                shippingProvider: "MENGANTAR",
                OR: [
                    ...(trackingNumber
                        ? [
                              {
                                  trackingNumber,
                              },
                          ]
                        : []),
                    ...(providerShipmentId
                        ? [
                              {
                                  providerShipmentId:
                                      providerShipmentId,
                              },
                          ]
                        : []),
                ],
            },
            select: {
                id: true,
                orderNumber: true,
                shipmentStatus: true,
                trackingNumber: true,
                shippingCourier: true,
            },
        });

        if (!order) {
            /*
             * Unknown shipment. Acknowledge so Mengantar stops
             * retrying, but never create or mutate an order. NO
             * error is surfaced (avoids leaking order existence).
             */
            console.warn(
                "MENGANTAR WEBHOOK: unknown shipment — acknowledged without change",
                {
                    hasTracking: Boolean(trackingNumber),
                    hasOrderId: Boolean(providerShipmentId),
                }
            );

            return NextResponse.json({
                success: true,
                message: "Unknown shipment.",
            });
        }

        const decision = decideMengantarShipmentTransition(
            order.shipmentStatus,
            statusCategory
        );

        if (!decision.allowed || !decision.nextStatus) {
            // Unknown, duplicate, terminal, or out-of-order event.
            // Preserve the existing state and acknowledge.
            return NextResponse.json({
                success: true,
                message: `No update (${decision.reason}).`,
            });
        }

        const nextStatus = decision.nextStatus;

        /*
         * CAS update: only apply when the stored status is still the
         * one we validated against, so two concurrent webhooks cannot
         * double-apply. A zero count means another delivery already
         * moved the shipment — acknowledge without a second effect.
         */
        const updated = await prisma.order.updateMany({
            where: {
                id: order.id,
                shipmentStatus:
                    order.shipmentStatus ?? null,
            },
            data: {
                shipmentStatus: nextStatus,
                // Backfill tracking/courier if the create flow had not
                // recorded them yet. NEVER overwrite an existing value.
                ...(order.trackingNumber || !trackingNumber
                    ? {}
                    : { trackingNumber }),
                ...(order.shippingCourier || !courierName
                    ? {}
                    : {
                          shippingCourier:
                              toInternalCourier(
                                  courierName
                              ),
                      }),
            },
        });

        if (updated.count === 0) {
            return NextResponse.json({
                success: true,
                message: "Concurrent update already applied.",
            });
        }

        /*
         * Shipment notification — reuses the EXISTING notification
         * system. Fire-and-forget: a notification failure must never
         * fail the webhook response (Mengantar has a 5s SLA / retry
         * policy). Idempotent via the shared notification key.
         */
        try {
            const { onShipmentStatusChanged } =
                await import(
                    "@/lib/notification/order-status-handler"
                );
            await onShipmentStatusChanged(
                order.id,
                order.shipmentStatus,
                nextStatus
            );
        } catch (notificationError) {
            console.error(
                "MENGANTAR WEBHOOK NOTIFICATION ERROR:",
                notificationError
            );
        }

        /*
         * NOTE: paymentStatus is intentionally untouched. COD
         * settlement and online payment reconciliation are separate
         * domains and require authoritative events, not shipment
         * status alone.
         */

        return NextResponse.json({
            success: true,
        });
    } catch (error) {
        console.error(
            "MENGANTAR WEBHOOK ERROR:",
            error instanceof Error
                ? redactMengantarKey(error.message)
                : error
        );

        // 500 lets Mengantar retry (bounded by its retry policy).
        return NextResponse.json(
            {
                success: false,
                message: "Webhook gagal diproses.",
            },
            { status: 500 }
        );
    }
}
