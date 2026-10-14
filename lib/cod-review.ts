import { prisma } from "@/lib/prisma";
import { cancelOrderForReservations } from "@/lib/checkout";

/*
 * ==========================================
 * COD REVIEW — REJECT (provider-aware)
 * ==========================================
 *
 * IMPORTANT CONTRACT CHANGE
 * -------------------------
 * The COD review is a RISK MARKER, not a fulfilment gate. A flagged COD
 * order is shipped automatically at checkout regardless of the review
 * state, so by the time an admin REJECTS it, Mengantar may ALREADY have
 * the parcel — or be creating it right now.
 *
 * Therefore REJECT can no longer "just cancel". It must never produce a
 * database that disagrees with Mengantar, so it refuses to touch
 * fulfilment once the provider has (or may have) accepted the shipment:
 *
 *   PROVIDER HAS THE PARCEL
 *     providerShipmentId / providerBatchId / trackingNumber is set, or
 *     shipmentStatus shows a handoff happened (CREATING, PAYING,
 *     WAITING_SHIPPING_PAYMENT, SHIPPING_PAID, CREATED, PICKED_UP,
 *     IN_TRANSIT, DELIVERED, UNDELIVERED, RETURNED), or a pickup slot is
 *     already scheduled.
 *     → the review is recorded as REJECTED, and NOTHING ELSE is
 *       touched: no stock returned, no order cancelled, no shipment
 *       marked cancelled. The admin resolves it operationally (the
 *       existing "Hapus Shipment" / manual flows) — the DB keeps telling
 *       the truth about what Mengantar holds.
 *
 *   JOB IN FLIGHT (PROCESSING)
 *     A worker may be inside the provider call at this very moment, so
 *     the outcome is unknown. The review is recorded as REJECTED and the
 *     cancellation is DEFERRED, not guessed.
 *
 *   NO PROVIDER HANDOFF, NO JOB IN FLIGHT
 *     Safe to cancel: the outbox job is stopped and the order is
 *     cancelled through the EXISTING safe lifecycle
 *     (`cancelOrderForReservations`): released stock (regular +
 *     flash-sale) and flash-sale purchase, restored voucher quota + the
 *     per-scope usage bucket, released the spin-wheel reward, cancelled
 *     the affiliate commission, soft-cancelled the order (row, items and
 *     history are NEVER deleted), and stopped the order's shipment jobs
 *     (status CANCELLED, kept for the record).
 *
 * MUTUAL EXCLUSION WITH THE WORKER
 * --------------------------------
 * Stopping the outbox is a CAS on `ShipmentJob.status = PENDING`, which
 * is the SAME transition the worker uses to claim work. Exactly one side
 * wins:
 *   * we win  → the worker can no longer claim it, and the order is
 *     cancelled before any provider call;
 *   * it wins → the job is PROCESSING, we detect that and cancel
 *     nothing.
 * The review decision itself is a second CAS on
 * `codReviewStatus = "PENDING"`, so two concurrent rejections (or an
 * approve racing a reject) cannot both act; the loser is told the
 * authoritative state.
 *
 * NO PROVIDER CALL IS EVER MADE HERE — only local rows are read/written.
 */

/** Shipment states that mean Mengantar already accepted a request. */
const PROVIDER_HANDOFF_SHIPMENT_STATUSES = [
    "CREATING",
    "PAYING",
    "WAITING_SHIPPING_PAYMENT",
    "SHIPPING_PAID",
    "CREATED",
    "PICKED_UP",
    "IN_TRANSIT",
    "DELIVERED",
    "UNDELIVERED",
    "RETURNED",
] as const;

type ProviderState = {
    shipmentStatus: string | null;
    providerShipmentId: string | null;
    providerBatchId: string | null;
    trackingNumber: string | null;
};

/**
 * True when there is local evidence that Mengantar has (or is creating)
 * this shipment. Deliberately conservative: anything that could mean a
 * POST /order already reached the provider counts.
 */
function hasProviderHandoff(order: ProviderState): boolean {
    if (
        order.providerShipmentId ||
        order.providerBatchId ||
        order.trackingNumber
    ) {
        return true;
    }

    const status = String(order.shipmentStatus ?? "")
        .trim()
        .toUpperCase();

    return (
        PROVIDER_HANDOFF_SHIPMENT_STATUSES as readonly string[]
    ).includes(status);
}

export type CodRejectSkipReason =
    | "PROVIDER_SHIPMENT_EXISTS"
    | "JOB_IN_FLIGHT";

export type CodRejectOutcome =
    | {
          ok: true;
          /** This call performed the PENDING → REJECTED transition. */
          changed: boolean;
          /** This call cancelled the order (released its reservations). */
          cancelled: boolean;
          /** PENDING/FAILED shipment jobs stopped by this call. */
          shipmentJobsStopped: number;
          /**
           * The local order was intentionally left ALONE because Mengantar
           * already holds the shipment (or a pickup is scheduled).
           */
          providerShipmentPreserved: boolean;
          /** The order was left alone because a worker is mid-flight. */
          jobInFlight: boolean;
          /** Present when the prefix was deliberately skipped. */
          skipReason?: CodRejectSkipReason;
          orderNumber: string;
          paymentStatus: string | null;
          shipmentStatus: string | null;
      }
    | {
          ok: false;
          reason:
              | "NOT_FOUND"
              | "NOT_REVIEWABLE"
              | "ALREADY_APPROVED"
              | "ALREADY_DECIDED";
      };

export async function rejectAndCancelCodOrder(input: {
    orderId: number;
    adminId: string;
    /** Free-form admin note, recorded in the audit log only. */
    note?: string | null;
}): Promise<CodRejectOutcome> {
    const order = await prisma.order.findUnique({
        where: { id: input.orderId },
        select: {
            id: true,
            orderNumber: true,
            paymentMethod: true,
            status: true,
            paymentStatus: true,
            requiresCodReview: true,
            codReviewStatus: true,
            shipmentStatus: true,
            providerShipmentId: true,
            providerBatchId: true,
            trackingNumber: true,
        },
    });

    if (!order) {
        return { ok: false, reason: "NOT_FOUND" };
    }

    if (!order.requiresCodReview) {
        return { ok: false, reason: "NOT_REVIEWABLE" };
    }

    if (order.codReviewStatus === "APPROVED") {
        return { ok: false, reason: "ALREADY_APPROVED" };
    }

    const alreadyRejected = order.codReviewStatus === "REJECTED";

    const outcome = await prisma.$transaction(
        async (tx) => {
            /* ---- 1. Record the review decision (CAS) ---- */
            let changed = false;

            if (!alreadyRejected) {
                const review = await tx.order.updateMany({
                    where: {
                        id: order.id,
                        requiresCodReview: true,
                        codReviewStatus: "PENDING",
                    },
                    data: {
                        codReviewStatus: "REJECTED",
                        codReviewedAt: new Date(),
                        codReviewedBy: input.adminId,
                    },
                });

                if (review.count === 0) {
                    /* Lost the race — report the authoritative state. */
                    return {
                        raced: true,
                        changed: false,
                        cancelled: false,
                        jobs: 0,
                        preserved: false,
                        jobInFlight: false,
                    };
                }

                changed = true;
            }

            /*
             * ---- 2. Re-read the provider state INSIDE the transaction ----
             *
             * The worker runs concurrently, so the state read before the
             * transaction may already be stale: it could have created the
             * shipment in the meantime. Cancel only what is still safe.
             */
            const current = await tx.order.findUnique({
                where: { id: order.id },
                select: {
                    shipmentStatus: true,
                    providerShipmentId: true,
                    providerBatchId: true,
                    trackingNumber: true,
                },
            });

            const job = await tx.shipmentJob.findUnique({
                where: { orderId: order.id },
                select: {
                    status: true,
                    pickupDate: true,
                    pickupTime: true,
                },
            });

            /*
             * A scheduled pickup lives at the provider too — treating it
             * as "not handed over" would cancel an order whose parcel is
             * already booked for collection.
             */
            const pickupScheduled = Boolean(
                job?.pickupDate && job?.pickupTime
            );

            if (
                !current ||
                hasProviderHandoff(current) ||
                pickupScheduled
            ) {
                return {
                    raced: false,
                    changed,
                    cancelled: false,
                    jobs: 0,
                    preserved: true,
                    jobInFlight: false,
                };
            }

            /*
             * ---- 3. Stop the outbox FIRST (mutual exclusion) ----
             *
             * PENDING/FAILED → CANCELLED is the same CAS the worker uses
             * to claim work, so only one side can win. FAILED is included
             * for convergence: a permanently-failed job must not be
             * resurrected by a later sweeper.
             */
            const jobs = await tx.shipmentJob.updateMany({
                where: {
                    orderId: order.id,
                    status: {
                        in: ["PENDING", "FAILED"],
                    },
                },
                data: {
                    status: "CANCELLED",
                    lockedAt: null,
                    lastError:
                        "Pesanan COD ditolak dan dibatalkan oleh admin.",
                },
            });

            /*
             * A PROCESSING job means a provider call may be in flight
             * RIGHT NOW and its outcome is unknown. Defer instead of
             * guessing: the review is recorded, nothing local is
             * cancelled, and the admin can reject again once the job
             * settles (the already-REJECTED path converges).
             */
            const inFlight = await tx.shipmentJob.count({
                where: {
                    orderId: order.id,
                    status: "PROCESSING",
                },
            });

            if (inFlight > 0) {
                return {
                    raced: false,
                    changed,
                    cancelled: false,
                    jobs: jobs.count,
                    preserved: false,
                    jobInFlight: true,
                };
            }

            /*
             * ---- 4. Cancel + release (safe: nothing reached Mengantar) ----
             *
             * restoreCart is false: this is an admin decision that the
             * order must not be fulfilled, not a buyer who wants to
             * re-order — and a guest order has no server-side cart to
             * restore into anyway.
             */
            const cancelled = await cancelOrderForReservations(
                tx,
                order.id,
                {
                    restoreCart: false,
                    /* An explicit admin cancellation may cancel COD. */
                    allowCodCancellation: true,
                }
            );

            return {
                raced: false,
                changed,
                cancelled,
                jobs: jobs.count,
                preserved: false,
                jobInFlight: false,
            };
        },
        {
            timeout: 20000,
            maxWait: 10000,
        }
    );

    const final = await prisma.order.findUnique({
        where: { id: order.id },
        select: {
            orderNumber: true,
            status: true,
            paymentStatus: true,
            codReviewStatus: true,
            shipmentStatus: true,
        },
    });

    if (!final) {
        return { ok: false, reason: "NOT_FOUND" };
    }

    if (outcome.raced) {
        return final.codReviewStatus === "APPROVED"
            ? { ok: false, reason: "ALREADY_APPROVED" }
            : { ok: false, reason: "ALREADY_DECIDED" };
    }

    const skipReason: CodRejectSkipReason | undefined =
        outcome.preserved
            ? "PROVIDER_SHIPMENT_EXISTS"
            : outcome.jobInFlight
              ? "JOB_IN_FLIGHT"
              : undefined;

    return {
        ok: true,
        changed: outcome.changed,
        cancelled: outcome.cancelled,
        shipmentJobsStopped: outcome.jobs,
        providerShipmentPreserved: outcome.preserved,
        jobInFlight: outcome.jobInFlight,
        skipReason,
        orderNumber: final.orderNumber,
        paymentStatus: final.paymentStatus,
        shipmentStatus: final.shipmentStatus ?? null,
    };
}
