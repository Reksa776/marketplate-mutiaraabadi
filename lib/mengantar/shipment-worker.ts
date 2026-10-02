import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { redactMengantarKey } from "@/lib/mengantar";
import {
    createShipmentForOrder,
    payUnpaidShipmentForOrder,
} from "@/lib/mengantar/shipment";

/*
 * ============================================================
 * MENGANTAR AUTO-SHIPMENT WORKER (durable outbox processor)
 * ============================================================
 *
 * There is no general job queue in this project (the notification
 * queue is in-memory only). This worker consumes the durable
 * `ShipmentJob` outbox so an authoritatively-PAID order eventually
 * gets exactly one Mengantar shipment.
 *
 * GUARANTEES:
 *   - Exactly-once enqueue: one ShipmentJob row per order
 *     (@@unique orderId).
 *   - Concurrency-safe: a job is claimed with an atomic CAS
 *     (PENDING + due → PROCESSING), so two workers cannot process
 *     the same job. The underlying shipment create/pay calls are
 *     themselves CAS-guarded too.
 *   - Retry with exponential backoff; stale PROCESSING locks (crashed
 *     worker) are reclaimed.
 *   - Refund/cancel safe: a cancelled/refunded order's job is
 *     CANCELLED and never creates a shipment. This worker NEVER
 *     writes Order.paymentStatus and NEVER touches the refund state
 *     machine.
 *   - Non-COD only: auto-shipping is disabled for COD until the COD
 *     contract is fully verified (COD jobs are cancelled).
 *
 * No credential is ever stored on the job; `lastError` is redacted.
 * ============================================================
 */

/** A PROCESSING job older than this is considered abandoned. */
const STALE_JOB_LOCK_MS = 10 * 60 * 1000;

const BASE_BACKOFF_MS = 60 * 1000; // 1 minute
const MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes

/** Shipment states that mean "no more create work is needed". */
const SHIPMENT_TERMINAL_OR_DONE = new Set([
    "CREATED",
    "SHIPPING_PAID",
    "PICKED_UP",
    "IN_TRANSIT",
    "DELIVERED",
    "UNDELIVERED",
    "RETURNED",
    "CANCELLED",
]);

function backoffMs(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);
    return Math.min(
        MAX_BACKOFF_MS,
        BASE_BACKOFF_MS * Math.pow(2, exponent)
    );
}

function safeMessage(error: unknown): string {
    const message =
        error instanceof Error ? error.message : String(error ?? "");

    return redactMengantarKey(message).slice(0, 500);
}

/*
 * ============================================================
 * ENQUEUE
 * ============================================================
 */

/**
 * Enqueue inside an existing settlement transaction. Uses
 * createMany + skipDuplicates so a duplicate/replayed settlement can
 * NEVER abort the payment transaction (no unique-constraint throw).
 */
export async function enqueueShipmentJobTx(
    tx: Prisma.TransactionClient,
    orderId: number
): Promise<void> {
    await tx.shipmentJob.createMany({
        data: [{ orderId }],
        skipDuplicates: true,
    });
}

/**
 * Enqueue outside a transaction. Idempotent: an existing job is left
 * untouched (it may already be DONE / in-flight).
 */
export async function enqueueShipmentJob(
    orderId: number
): Promise<void> {
    await prisma.shipmentJob.upsert({
        where: { orderId },
        create: { orderId },
        update: {},
    });
}

/*
 * ============================================================
 * PROCESSING
 * ============================================================
 */

/** Mark a claimed job finished. Only the claim holder may finalize. */
async function finishJob(
    jobId: number,
    status: "DONE" | "FAILED" | "CANCELLED",
    lastError: string | null
): Promise<void> {
    await prisma.shipmentJob.updateMany({
        where: { id: jobId, status: "PROCESSING" },
        data: { status, lockedAt: null, lastError },
    });
}

/** Schedule a retry, or fail permanently when the budget is spent. */
async function retryJob(
    job: { id: number; attempts: number; maxAttempts: number },
    reason: string
): Promise<void> {
    if (job.attempts >= job.maxAttempts) {
        await finishJob(job.id, "FAILED", reason);
        return;
    }

    await prisma.shipmentJob.updateMany({
        where: { id: job.id, status: "PROCESSING" },
        data: {
            status: "PENDING",
            lockedAt: null,
            lastError: reason,
            nextAttemptAt: new Date(
                Date.now() + backoffMs(job.attempts)
            ),
        },
    });
}

async function notifyShipment(
    orderId: number,
    previousStatus: string | null,
    newStatus: string
): Promise<void> {
    try {
        const { onShipmentStatusChanged } = await import(
            "@/lib/notification/order-status-handler"
        );
        await onShipmentStatusChanged(
            orderId,
            previousStatus,
            newStatus
        );
    } catch (error) {
        console.error(
            "MENGANTAR AUTO-SHIPMENT NOTIFICATION ERROR:",
            error
        );
    }
}

/**
 * Process one already-claimed job. Never throws — a failure is
 * converted into a retry (or permanent failure).
 */
async function processClaimedJob(
    jobId: number,
    orderId: number
): Promise<void> {
    const job = await prisma.shipmentJob.findUnique({
        where: { id: jobId },
    });

    if (!job || job.status !== "PROCESSING") {
        return;
    }

    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            status: true,
            paymentStatus: true,
            paymentMethod: true,
            shippingProvider: true,
            shipmentStatus: true,
            shippingPaymentStatus: true,
        },
    });

    if (!order) {
        await finishJob(jobId, "CANCELLED", "Pesanan tidak ditemukan.");
        return;
    }

    // ---- Refund / cancellation guard (never create fakes) ----
    if (
        order.status === "CANCELLED" ||
        order.paymentStatus === "REFUNDED"
    ) {
        await finishJob(
            jobId,
            "CANCELLED",
            "Pesanan dibatalkan/direfund."
        );
        return;
    }

    if (order.shippingProvider !== "MENGANTAR") {
        await finishJob(jobId, "CANCELLED", "Provider bukan Mengantar.");
        return;
    }

    // ---- Non-COD only (COD frozen until contract verified) ----
    if (order.paymentMethod === "COD") {
        await finishJob(
            jobId,
            "CANCELLED",
            "Auto-shipping COD belum diaktifkan."
        );
        return;
    }

    // Already created (e.g. admin manual action won the race).
    if (
        order.shipmentStatus &&
        SHIPMENT_TERMINAL_OR_DONE.has(order.shipmentStatus)
    ) {
        await finishJob(jobId, "DONE", null);
        return;
    }

    try {
        if (job.stage === "PAY") {
            const result = await payUnpaidShipmentForOrder(orderId);

            if (
                result.ok &&
                (result.shipmentStatus === "CREATED" ||
                    result.shippingPaymentStatus === "PAID")
            ) {
                await finishJob(jobId, "DONE", null);
                await notifyShipment(
                    orderId,
                    "WAITING_SHIPPING_PAYMENT",
                    "CREATED"
                );
                return;
            }

            // Still short of balance (or transient) → retry later.
            await retryJob(
                job,
                result.reason ?? "Ongkir belum dapat dibayar."
            );
            return;
        }

        // ---- stage CREATE ----
        const result = await createShipmentForOrder(orderId);

        if (!result.ok) {
            await retryJob(
                job,
                result.reason ?? "Gagal membuat shipment."
            );
            return;
        }

        const scheduleData = result.pickupSchedule
            ? {
                  pickupDate: result.pickupSchedule.date,
                  pickupTime: result.pickupSchedule.time,
              }
            : {};

        if (result.shipmentStatus === "WAITING_SHIPPING_PAYMENT") {
            // Order created but seller balance insufficient → payment
            // stage. Customer paymentStatus stays PAID (untouched).
            await prisma.shipmentJob.updateMany({
                where: { id: jobId, status: "PROCESSING" },
                data: {
                    stage: "PAY",
                    status: "PENDING",
                    lockedAt: null,
                    lastError: null,
                    nextAttemptAt: new Date(
                        Date.now() + backoffMs(job.attempts)
                    ),
                    ...scheduleData,
                },
            });
            return;
        }

        await prisma.shipmentJob.updateMany({
            where: { id: jobId, status: "PROCESSING" },
            data: {
                status: "DONE",
                lockedAt: null,
                lastError: null,
                ...scheduleData,
            },
        });

        await notifyShipment(orderId, null, "CREATED");
    } catch (error) {
        await retryJob(job, safeMessage(error));
    }
}

/**
 * Process all currently-due jobs (bounded). Safe to call from a cron
 * / admin sweeper / `after()` hook. Returns how many were processed.
 */
export async function processShipmentJobs({
    limit = 10,
}: { limit?: number } = {}): Promise<{ processed: number }> {
    // Reclaim abandoned PROCESSING jobs (crashed worker).
    await prisma.shipmentJob.updateMany({
        where: {
            status: "PROCESSING",
            lockedAt: {
                lt: new Date(Date.now() - STALE_JOB_LOCK_MS),
            },
        },
        data: { status: "PENDING", lockedAt: null },
    });

    const now = new Date();

    const due = await prisma.shipmentJob.findMany({
        where: {
            status: "PENDING",
            nextAttemptAt: { lte: now },
        },
        orderBy: { nextAttemptAt: "asc" },
        take: Math.max(1, limit),
        select: { id: true, orderId: true },
    });

    let processed = 0;

    for (const candidate of due) {
        const claimed = await prisma.shipmentJob.updateMany({
            where: {
                id: candidate.id,
                status: "PENDING",
                nextAttemptAt: { lte: now },
            },
            data: {
                status: "PROCESSING",
                lockedAt: new Date(),
                attempts: { increment: 1 },
            },
        });

        if (claimed.count === 0) continue;

        await processClaimedJob(
            candidate.id,
            candidate.orderId
        );

        processed++;
    }

    return { processed };
}

/**
 * Force a retry for a single order (admin recovery). Resets the
 * attempt budget, then processes immediately. Safe when no job
 * exists yet (creates one).
 */
export async function runShipmentJobForOrder(
    orderId: number
): Promise<{ ok: boolean; reason?: string }> {
    const job = await prisma.shipmentJob.upsert({
        where: { orderId },
        create: { orderId },
        update: {
            status: "PENDING",
            stage: "CREATE",
            attempts: 0,
            nextAttemptAt: new Date(),
            lockedAt: null,
            lastError: null,
        },
    });

    const claimed = await prisma.shipmentJob.updateMany({
        where: { id: job.id, status: "PENDING" },
        data: {
            status: "PROCESSING",
            lockedAt: new Date(),
            attempts: { increment: 1 },
        },
    });

    if (claimed.count === 0) {
        return {
            ok: false,
            reason: "Job shipment sedang diproses.",
        };
    }

    await processClaimedJob(job.id, orderId);

    return { ok: true };
}

/**
 * Fire-and-forget processing after the current response is sent.
 * Uses Next.js `after()` when available (Route Handler scope) so the
 * payment webhook never blocks on a Mengantar API call; falls back to
 * a detached promise otherwise. Any failure is swallowed — the job
 * stays PENDING for the sweeper.
 */
export async function scheduleShipmentProcessing(): Promise<void> {
    try {
        const { after } = await import("next/server");

        after(async () => {
            try {
                await processShipmentJobs({ limit: 5 });
            } catch (error) {
                console.error(
                    "MENGANTAR AUTO-SHIPMENT AFTER() ERROR:",
                    safeMessage(error)
                );
            }
        });
    } catch {
        void processShipmentJobs({ limit: 5 }).catch(() => {
            /* swallow — sweeper will retry */
        });
    }
}
