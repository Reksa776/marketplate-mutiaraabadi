import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/admin/audit-log";
import { rejectAndCancelCodOrder } from "@/lib/cod-review";
import { enqueueShipmentJob } from "@/lib/mengantar/shipment-worker";

export const dynamic = "force-dynamic";

type RouteContext = {
    params: Promise<{ id: string }>;
};

/**
 * ==========================================
 * ADMIN COD REVIEW
 * ==========================================
 *
 * High-risk COD orders are FLAGGED at checkout
 * (`requiresCodReview = true`, `codReviewStatus = "PENDING"`) and
 * deliberately get NO ShipmentJob, so nothing is handed to Mengantar
 * until a human approves it. This endpoint is that human gate.
 *
 *   POST { action: "APPROVE" }  → codReviewStatus = APPROVED and the
 *                                 ShipmentJob is enqueued, after which
 *                                 the normal worker creates the
 *                                 Mengantar shipment exactly as it does
 *                                 for every other COD order.
 *   POST { action: "REJECT"  }  → codReviewStatus = REJECTED **and the
 *                                 order is CANCELLED** through the
 *                                 existing safe cancellation lifecycle
 *                                 (lib/cod-review.ts →
 *                                 cancelOrderForReservations): stock and
 *                                 flash-sale reservations released,
 *                                 voucher quota + per-scope usage
 *                                 restored, spin reward released,
 *                                 affiliate commission cancelled,
 *                                 shipment jobs stopped, and the buyer
 *                                 notified. The order row and its
 *                                 history are never deleted.
 *
 * GUARANTEES
 * ----------
 *  1. ADMIN only (401 unauthenticated, 403 for any other role).
 *  2. ATOMIC: the review transition and the cancellation commit in ONE
 *     transaction, and the transition itself is a conditional
 *     `updateMany`, so two concurrent reviewers cannot both "win" —
 *     exactly one request performs the transition (and therefore
 *     exactly one cancels/enqueues).
 *  3. IDEMPOTENT: approving an already-APPROVED order returns success
 *     with `changed: false` and no second job; rejecting an
 *     already-REJECTED order converges (stops any lingering shipment
 *     job, finishes the cancellation) without releasing anything twice
 *     — the cancellation CAS guarantees a single release.
 *  4. An APPROVED order is never cancelled: approval is an explicit
 *     release of the hold and this endpoint refuses to reverse it (409).
 *  5. The COD payment lifecycle is untouched: `paymentStatus` stays
 *     UNPAID until the courier collects, exactly as before this flag
 *     existed. A rejection cancels the order, which is the one
 *     intentional exception — and it is a decision an admin makes
 *     explicitly, never an automatic one.
 */

const ACTIONS = ["APPROVE", "REJECT"] as const;

type ReviewAction = (typeof ACTIONS)[number];

function isReviewAction(value: unknown): value is ReviewAction {
    return (
        typeof value === "string" &&
        (ACTIONS as readonly string[]).includes(value)
    );
}

export async function POST(
    req: Request,
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
                        "Akses ditolak. Hanya admin yang dapat meninjau COD.",
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

        /* Body is optional for APPROVE; note is never required. */
        let body: Record<string, unknown> = {};

        try {
            body = (await req.json()) as Record<
                string,
                unknown
            >;
        } catch {
            body = {};
        }

        const action = body.action;

        if (!isReviewAction(action)) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Aksi tidak valid. Gunakan APPROVE atau REJECT.",
                },
                { status: 400 }
            );
        }

        const note =
            typeof body.note === "string"
                ? body.note.trim().slice(0, 500)
                : null;

        const order = await prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                orderNumber: true,
                status: true,
                paymentMethod: true,
                paymentStatus: true,
                shippingProvider: true,
                total: true,
                requiresCodReview: true,
                codReviewStatus: true,
                shipmentJob: {
                    select: {
                        status: true,
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

        if (!order.requiresCodReview) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Pesanan ini tidak memerlukan tinjauan COD.",
                },
                { status: 409 }
            );
        }

        /* ==========================================
         * REJECT — reject & cancel (single path)
         * ==========================================
         *
         * Handled FIRST and in one place: the review decision, the
         * cancellation and the shipment-job stop must be one atomic
         * unit, so they cannot be split across this route and a later
         * step. The service also owns the already-rejected /
         * already-approved / lost-the-race outcomes.
         */
        if (action === "REJECT") {
            const rejected = await rejectAndCancelCodOrder({
                orderId,
                adminId: session.user.id,
                note,
            });

            if (!rejected.ok) {
                if (rejected.reason === "NOT_FOUND") {
                    return NextResponse.json(
                        {
                            success: false,
                            message:
                                "Pesanan tidak ditemukan.",
                        },
                        { status: 404 }
                    );
                }

                if (
                    rejected.reason === "ALREADY_APPROVED"
                ) {
                    return NextResponse.json(
                        {
                            success: false,
                            message:
                                "Tinjauan COD sudah DISETUJUI. Pesanan tidak dibatalkan.",
                        },
                        { status: 409 }
                    );
                }

                if (
                    rejected.reason === "NOT_REVIEWABLE"
                ) {
                    return NextResponse.json(
                        {
                            success: false,
                            message:
                                "Pesanan ini tidak memerlukan tinjauan COD.",
                        },
                        { status: 409 }
                    );
                }

                /*
                 * Another reviewer decided while we were working.
                 */
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            "Tinjauan COD sudah diputuskan oleh admin lain.",
                    },
                    { status: 409 }
                );
            }

            /*
             * BUYER NOTIFICATION — the EXISTING order-status pipeline
             * (same provider, same template, idempotent by
             * order+transition key), fire-and-forget. Only a real
             * cancellation notifies; a no-op replay stays silent.
             */
            if (rejected.cancelled) {
                try {
                    const { onOrderStatusChanged } =
                        await import(
                            "@/lib/notification/order-status-handler"
                        );

                    await onOrderStatusChanged(
                        orderId,
                        order.status,
                        "CANCELLED"
                    );
                } catch (notificationError) {
                    console.error(
                        "COD REJECT NOTIFICATION ERROR:",
                        notificationError
                    );
                }
            }

            await createAuditLog({
                adminId: session.user.id,
                action: "COD_REVIEW_REJECTED",
                entityType: "Order",
                entityId: orderId,
                description: `COD order ${rejected.orderNumber} rejected; order cancelled and reservations released`,
                metadata: {
                    orderNumber: rejected.orderNumber,
                    total: Number(order.total),
                    changed: rejected.changed,
                    orderCancelled: rejected.cancelled,
                    shipmentJobsStopped:
                        rejected.shipmentJobsStopped,
                    paymentStatus: rejected.paymentStatus,
                    note,
                },
            });

            return NextResponse.json({
                success: true,
                message: rejected.cancelled
                    ? "Tinjauan COD ditolak. Pesanan dibatalkan dan stok dikembalikan."
                    : "Tinjauan COD ditolak. Pesanan sudah dalam keadaan dibatalkan.",
                data: {
                    changed: rejected.changed,
                    codReviewStatus: "REJECTED",
                    shipmentEnqueued: false,
                    orderCancelled: rejected.cancelled,
                    paymentStatus: rejected.paymentStatus,
                },
            });
        }

        /* ==========================================
         * APPROVE
         * ========================================== */

        /*
         * ALREADY APPROVED — idempotent success, but make sure
         * the shipment job really exists (a crash between the
         * update and the enqueue must not strand the order).
         */
        if (order.codReviewStatus === "APPROVED") {
            const enqueued = await ensureShipmentEnqueued(
                order
            );

            return NextResponse.json({
                success: true,
                message: "Tinjauan COD sudah disetujui.",
                data: {
                    changed: false,
                    codReviewStatus: "APPROVED",
                    shipmentEnqueued: enqueued,
                    alreadyReviewed: true,
                },
            });
        }

        /*
         * A REJECTED order is terminal for the review: approving it
         * afterwards would resurrect an order that was explicitly
         * cancelled. The buyer re-orders instead, which keeps the audit
         * trail honest.
         */
        if (order.codReviewStatus === "REJECTED") {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Tinjauan COD sudah DITOLAK dan pesanan sudah dibatalkan.",
                },
                { status: 409 }
            );
        }

        /*
         * ATOMIC TRANSITION — only one concurrent reviewer moves a
         * PENDING review, so only one request enqueues a shipment.
         */
        const transitioned =
            await prisma.order.updateMany({
                where: {
                    id: orderId,
                    requiresCodReview: true,
                    codReviewStatus: "PENDING",
                },
                data: {
                    codReviewStatus: "APPROVED",
                    codReviewedAt: new Date(),
                    codReviewedBy: session.user.id,
                },
            });

        if (transitioned.count === 0) {
            /*
             * Another reviewer won the race in the meantime.
             * Report the authoritative state instead of acting twice.
             */
            const current = await prisma.order.findUnique(
                {
                    where: { id: orderId },
                    select: {
                        codReviewStatus: true,
                    },
                }
            );

            return NextResponse.json(
                {
                    success: false,
                    message: `Tinjauan COD sudah diputuskan (${current?.codReviewStatus ?? "UNKNOWN"}).`,
                },
                { status: 409 }
            );
        }

        const enqueued = await ensureShipmentEnqueued(
            order
        );

        await createAuditLog({
            adminId: session.user.id,
            action: "COD_REVIEW_APPROVED",
            entityType: "Order",
            entityId: orderId,
            description: `COD order ${order.orderNumber} approved for shipment`,
            metadata: {
                orderNumber: order.orderNumber,
                total: Number(order.total),
                shippingProvider:
                    order.shippingProvider,
                shipmentEnqueued: enqueued,
                note,
            },
        });

        return NextResponse.json({
            success: true,
            message:
                "Tinjauan COD disetujui. Shipment akan diproses.",
            data: {
                changed: true,
                codReviewStatus: "APPROVED",
                shipmentEnqueued: enqueued,
            },
        });
    } catch (error) {
        console.error("ADMIN COD REVIEW ERROR:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Gagal memproses tinjauan COD.",
            },
            { status: 500 }
        );
    }
}

/**
 * Enqueue the shipment job for an approved COD order.
 *
 * Only applies to COD orders shipped through Mengantar, and only when
 * the provider shipment does not already exist — enqueuing an
 * already-fulfilled order would be pointless work for the worker.
 *
 * `enqueueShipmentJob` upserts on the unique `ShipmentJob.orderId`, so
 * this is safe to call from a retried or replayed approval.
 */
async function ensureShipmentEnqueued(order: {
    id: number;
    paymentMethod: string;
    shippingProvider: string | null;
    shipmentJob: { status: string } | null;
}): Promise<boolean> {

    if (order.paymentMethod !== "COD") {
        return false;
    }

    if (order.shippingProvider !== "MENGANTAR") {
        return false;
    }

    if (
        order.shipmentJob &&
        order.shipmentJob.status === "DONE"
    ) {
        /* Already shipped — nothing to enqueue. */
        return false;
    }

    /*
     * An in-flight job is left alone: resetting it would clobber the
     * worker that is already creating this shipment.
     */
    if (
        order.shipmentJob &&
        order.shipmentJob.status === "PROCESSING"
    ) {
        return false;
    }

    /*
     * An approval is an explicit RELEASE of a hold, so any terminal
     * job state left behind by the worker's review gate (CANCELLED),
     * by a failure, or by a previous sweep is reset to PENDING —
     * otherwise `enqueueShipmentJob` (upsert with an empty update)
     * would leave the order never shipped.
     */
    if (
        order.shipmentJob &&
        order.shipmentJob.status !== "PENDING"
    ) {
        await enqueueShipmentJob(order.id);

        await prisma.shipmentJob.updateMany({
            where: {
                orderId: order.id,
                status: {
                    in: ["CANCELLED", "FAILED"],
                },
            },
            data: {
                status: "PENDING",
                stage: "CREATE",
                attempts: 0,
                nextAttemptAt: new Date(),
                lockedAt: null,
                lastError: null,
            },
        });

        return true;
    }

    await enqueueShipmentJob(order.id);

    return true;
}
