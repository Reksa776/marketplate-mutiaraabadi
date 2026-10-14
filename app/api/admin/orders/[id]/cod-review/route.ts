import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/admin/audit-log";
import { rejectAndCancelCodOrder } from "@/lib/cod-review";
import {
    enqueueShipmentJob,
    scheduleShipmentProcessing,
} from "@/lib/mengantar/shipment-worker";

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
 * (`requiresCodReview = true`, `codReviewStatus = "PENDING"`) so an
 * admin can see the risk and record a decision.
 *
 * THE REVIEW IS NOT A FULFILMENT GATE. The shipment is already being
 * created automatically at checkout (the ShipmentJob is enqueued there
 * and the worker contacts Mengantar), regardless of the review state —
 * that automation is the whole point, and making it wait for an admin
 * click stranded production order #985. This endpoint therefore only
 * records a business decision about an order that is (or may already
 * be) on its way:
 *
 *   POST { action: "APPROVE" }  → codReviewStatus = APPROVED, audited.
 *                                 The shipment was already requested and
 *                                 is NOT affected. Any leftover
 *                                 CANCELLED/FAILED job from an older
 *                                 release is re-queued as a safety net
 *                                 (idempotent, same single worker).
 *   POST { action: "REJECT"  }  → codReviewStatus = REJECTED, audited,
 *                                 and the order is cancelled ONLY when
 *                                 Mengantar has nothing yet (see
 *                                 lib/cod-review.ts). If the provider
 *                                 already holds the shipment or a pickup
 *                                 is scheduled, the local order is left
 *                                 ALONE so the database never disagrees
 *                                 with Mengantar; if a worker is
 *                                 mid-flight the cancellation is
 *                                 deferred rather than guessed.
 *
 * GUARANTEES
 * ----------
 *  1. ADMIN only (401 unauthenticated, 403 for any other role).
 *  2. ATOMIC: the review decision and (when it is allowed) the
 *     cancellation commit in ONE transaction, and the decision itself
 *     is a conditional `updateMany`, so two concurrent reviewers cannot
 *     both act — the loser is told the authoritative state.
 *  3. IDEMPOTENT: approving an already-APPROVED order returns success
 *     with `changed: false`; rejecting an already-REJECTED order
 *     converges (stops any lingering job, finishes a still-safe
 *     cancellation) without releasing anything twice — the cancellation
 *     CAS guarantees a single release.
 *  4. An APPROVED order is never cancelled by this endpoint.
 *  5. PROVIDER-SAFE: a rejection never cancels an order whose shipment
 *     Mengantar already holds (or whose pickup is scheduled), and never
 *     guesses while a worker is mid-flight. See lib/cod-review.ts.
 *  6. The COD payment lifecycle is untouched: `paymentStatus` stays
 *     UNPAID until the courier collects. Only an explicit, safe
 *     rejection cancels an order — never an automatic decision.
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
                description: rejected.cancelled
                    ? `COD order ${rejected.orderNumber} rejected; NOT yet handed to the provider, order cancelled and reservations released`
                    : `COD order ${rejected.orderNumber} rejected; fulfilment NOT touched (${rejected.skipReason ?? "already decided"})`,
                metadata: {
                    orderNumber: rejected.orderNumber,
                    total: Number(order.total),
                    changed: rejected.changed,
                    orderCancelled: rejected.cancelled,
                    providerShipmentPreserved:
                        rejected.providerShipmentPreserved,
                    jobInFlight: rejected.jobInFlight,
                    skipReason: rejected.skipReason ?? null,
                    shipmentStatus: rejected.shipmentStatus,
                    shipmentJobsStopped:
                        rejected.shipmentJobsStopped,
                    paymentStatus: rejected.paymentStatus,
                    note,
                },
            });

            /*
             * OUTCOME MESSAGE must be honest about what was NOT done: the
             * admin has to know that a parcel already with the courier was
             * left alone (so they resolve it operationally) instead of
             * believing the order was cancelled.
             */
            const rejectMessage = rejected.cancelled
                ? "Tinjauan COD ditolak. Pesanan dibatalkan dan stok dikembalikan."
                : rejected.providerShipmentPreserved
                  ? "Tinjauan COD ditolak. Shipment sudah ada di Mengantar, jadi pesanan TIDAK dibatalkan otomatis — selesaikan secara operasional agar data tetap sinkron dengan provider."
                  : rejected.jobInFlight
                    ? "Tinjauan COD ditolak. Shipment sedang diproses; pembatalan ditunda agar tidak memutus shipment yang mungkin sudah dikirim ke Mengantar. Coba tolak lagi setelah proses selesai."
                    : "Tinjauan COD ditolak. Pesanan sudah dalam keadaan dibatalkan.";

            return NextResponse.json({
                success: true,
                message: rejectMessage,
                data: {
                    changed: rejected.changed,
                    codReviewStatus: "REJECTED",
                    shipmentEnqueued: false,
                    orderCancelled: rejected.cancelled,
                    providerShipmentPreserved:
                        rejected.providerShipmentPreserved,
                    jobInFlight: rejected.jobInFlight,
                    skipReason: rejected.skipReason ?? null,
                    shipmentStatus: rejected.shipmentStatus,
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

            await nudgeWorker(enqueued);

            return NextResponse.json({
                success: true,
                message:
                    "Tinjauan COD sudah disetujui. Pengiriman berjalan otomatis.",
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

        await nudgeWorker(enqueued);

        await createAuditLog({
            adminId: session.user.id,
            action: "COD_REVIEW_APPROVED",
            entityType: "Order",
            entityId: orderId,
            description: `COD order ${order.orderNumber} review approved (risk marker; fulfilment is automatic)`,
            metadata: {
                orderNumber: order.orderNumber,
                total: Number(order.total),
                shippingProvider:
                    order.shippingProvider,
                shipmentJobRecovered: enqueued,
                note,
            },
        });

        return NextResponse.json({
            success: true,
            message: enqueued
                ? "Tinjauan COD disetujui. Antrean shipment yang tertinggal sudah dipulihkan."
                : "Tinjauan COD disetujui. Pengiriman tetap berjalan otomatis, tidak bergantung pada keputusan ini.",
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
 * Nudge the EXISTING shipment worker when a re-queued job was found.
 *
 * This is ONLY a recovery nudge for an order whose job was left in a
 * terminal state by an older release (before the review gate was
 * removed). The shipment is normally requested automatically at
 * checkout; the review decision plays no part in it. It reuses the SAME
 * post-response trigger (`after()` + an idempotent worker claim) every
 * COD checkout already uses, so nothing new is introduced and a
 * duplicate/replayed call stays a no-op.
 */
async function nudgeWorker(
    enqueued: boolean
): Promise<void> {
    if (!enqueued) {
        return;
    }

    await scheduleShipmentProcessing();
}

/**
 * RECOVERY SAFETY NET (not a gate, not a second creation path).
 *
 * The shipment job is enqueued automatically at COD checkout, so this
 * normally finds an existing job and does nothing. It exists to heal an
 * order whose job is missing or was left CANCELLED/FAILED by an older
 * release (the review gate used to cancel jobs, which is what stranded
 * production order #985).
 *
 * It writes ONLY the outbox row that the single existing worker
 * consumes — it never talks to Mengantar and never creates a shipment
 * itself — and `enqueueShipmentJob` upserts on the unique
 * `ShipmentJob.orderId`, so a retried or replayed call cannot produce a
 * second job (or a second shipment).
 *
 * Only applies to COD orders shipped through Mengantar, and never for
 * an order that already has a provider shipment.
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
     * A terminal job state left behind by the OLD review gate
     * (CANCELLED), by a failure, or by a previous sweep is reset to
     * PENDING — otherwise `enqueueShipmentJob` (upsert with an empty
     * update) would leave the order never shipped.
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
