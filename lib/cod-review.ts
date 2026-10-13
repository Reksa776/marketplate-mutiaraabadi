import { prisma } from "@/lib/prisma";
import { cancelOrderForReservations } from "@/lib/checkout";

/**
 * ==========================================
 * COD REVIEW — REJECT & CANCEL
 * ==========================================
 *
 * A high-risk COD order is FLAGGED at checkout (`requiresCodReview`,
 * `codReviewStatus = "PENDING"`) and gets NO ShipmentJob, so nothing is
 * handed to Mengantar before an admin looks at it. An admin who rejects
 * it decides the order must not be delivered — and an order that will
 * never be delivered must not keep holding inventory.
 *
 * So REJECT is a REJECT & CANCEL, and it reuses the EXISTING safe
 * cancellation lifecycle verbatim (`cancelOrderForReservations`, the
 * same primitive `rollbackCheckoutOrder` runs):
 *
 *   1. release reserved stock (regular + flash-sale) and the
 *      flash-sale purchase record,
 *   2. restore the voucher quota AND the per-scope usage bucket (guest
 *      scope included, so a guest gets their allowance back),
 *   3. release the spin-wheel reward,
 *   4. cancel the affiliate commission,
 *   5. soft-cancel the order (status CANCELLED, paymentStatus FAILED) —
 *      the row, its items and its history are NEVER deleted, and
 *   6. stop the order's shipment jobs (status CANCELLED, kept for the
 *      record — not deleted).
 *
 * ATOMICITY
 * ---------
 * The review decision and the cancellation run in ONE transaction: there
 * is no window in which an order is marked REJECTED but still holds
 * stock, or cancelled but still PENDING review.
 *
 * IDEMPOTENCY
 * -----------
 *   * The review transition is a conditional update on
 *     `codReviewStatus = "PENDING"`, so two concurrent rejections (or an
 *     approve racing a reject) cannot both act; the loser is told the
 *     authoritative state.
 *   * The cancellation is guarded by its own CAS on the order status, so
 *     a repeat call releases nothing a second time.
 *   * Re-calling REJECT on an order that is already REJECTED is a safe
 *     CONVERGENCE step: it stops any remaining shipment job and finishes
 *     the cancellation if the previous decision (from an older release
 *     that only held the order) never cancelled it.
 *
 * An APPROVED order is never cancelled here: approval is an explicit
 * release of the hold, and the endpoint refuses to reverse it.
 */

export type CodRejectOutcome =
    | {
          ok: true;
          /** This call performed the PENDING → REJECTED transition. */
          changed: boolean;
          /** This call cancelled the order (released its reservations). */
          cancelled: boolean;
          /** PENDING/PROCESSING shipment jobs stopped by this call. */
          shipmentJobsStopped: number;
          orderNumber: string;
          paymentStatus: string | null;
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

    const alreadyRejected =
        order.codReviewStatus === "REJECTED";

    const outcome = await prisma.$transaction(
        async (tx) => {
            let changed = false;

            if (!alreadyRejected) {
                /*
                 * ATOMIC REVIEW DECISION — exactly one reviewer moves a
                 * PENDING review, so exactly one request may cancel.
                 */
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
                    };
                }

                changed = true;
            }

            /*
             * CANCELLATION — inside the SAME transaction as the review
             * decision, so the release can never be skipped by a crash
             * between two commits.
             *
             * restoreCart is false: this is an admin decision that the
             * order must not be fulfilled, not a buyer who wants to
             * re-order — and a guest order has no server-side cart to
             * restore into anyway.
             */
            const cancelled =
                await cancelOrderForReservations(tx, order.id, {
                    restoreCart: false,
                    /* An explicit admin cancellation may cancel COD. */
                    allowCodCancellation: true,
                });

            /*
             * STOP THE SHIPMENT JOB — never delete it. A CANCELLED job
             * is inert for the worker (which only claims PENDING jobs and
             * refuses an order that is CANCELLED), and keeping the row
             * preserves what happened for the record.
             */
            const jobs = await tx.shipmentJob.updateMany({
                where: {
                    orderId: order.id,
                    status: {
                        in: ["PENDING", "PROCESSING"],
                    },
                },
                data: {
                    status: "CANCELLED",
                    lockedAt: null,
                    lastError:
                        "Pesanan COD ditolak dan dibatalkan oleh admin.",
                },
            });

            return {
                raced: false,
                changed,
                cancelled,
                jobs: jobs.count,
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

    return {
        ok: true,
        changed: outcome.changed,
        cancelled: outcome.cancelled,
        shipmentJobsStopped: outcome.jobs,
        orderNumber: final.orderNumber,
        paymentStatus: final.paymentStatus,
    };
}
