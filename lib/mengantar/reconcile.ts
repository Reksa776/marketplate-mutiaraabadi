import { prisma } from "@/lib/prisma";
import {
    getMengantarOrderByOrderId,
    getMengantarOrderByTracking,
    redactMengantarKey,
} from "@/lib/mengantar";

/*
 * ============================================================
 * MENGANTAR SHIPMENT RECONCILIATION — SELF-HEALING
 * ============================================================
 *
 * Problem: an order can be CREATED locally (`providerShipmentId`,
 * `providerBatchId`, `trackingNumber`, ShipmentJob DONE) while the
 * provider-side shipment has been DELETED/CANCELLED from the
 * Mengantar dashboard. Every local create guard then sees "shipment
 * already exists" and automatic shipping is permanently stuck.
 *
 * This module detects that discrepancy and, ONLY when the provider
 * authoritatively confirms the shipment no longer exists, resets the
 * order to SHIPMENT_PENDING and re-queues the ShipmentJob so the
 * existing worker creates a fresh shipment:
 *
 *   CREATED → provider confirmed missing → SHIPMENT_PENDING
 *           → ShipmentJob PENDING → worker → POST /order → CREATED
 *
 * SAFETY (hard rules):
 *   - `shippingProvider` = "MENGANTAR", `paymentStatus` = PAID and
 *     non-COD are ALL required. COD never self-heals.
 *   - A provider read that is NOT a confirmed "not found" (401/403
 *     credential, 429 rate limit, 5xx, timeout, network error,
 *     malformed response, or an entry without ORDER_ID) is treated
 *     as UNCERTAIN and NEVER triggers a reset.
 *   - The reset is an atomic CAS on the exact `CREATED` +
 *     `providerShipmentId` we verified, so concurrent reconcilers
 *     cannot double-reset, and the existing worker claim remains the
 *     single gate before any `POST /order`.
 *   - NEVER writes Order.paymentStatus.
 * ============================================================
 */

/**
 * Only reconcile shipments that have been stable for a while. This
 * keeps a just-created shipment (still finishing its DB finalize /
 * webhook) out of the reconciliation window entirely.
 */
export const MENGANTAR_RECONCILE_MIN_AGE_MS =
    30 * 60 * 1000;

/** Only a locally-CREATED shipment can be the "already made" false
 * positive described above. In-transit parcels are never reset. */
const RECONCILE_ELIGIBLE_STATUS = "CREATED";

export type MengantarLookupVerdict =
    | "exists"
    | "missing"
    | "uncertain";

/**
 * PURE. Interpret an AUTHORITATIVE lookup result (by providerShipmentId
 * / ORDER_ID). The official GET /order documents `order_id` as a
 * unique lookup, so:
 *
 *   null                      → provider has no such order → missing
 *   entry with isDeleted:true → provider deleted it         → missing
 *   any other returned entry  → it still exists             → exists
 *
 * A returned row is ALWAYS treated as "exists" (never "missing"), so
 * this can only ever fail safe towards NOT resetting.
 */
export function classifyMengantarLookup(
    result: { isDeleted?: boolean } | null
): MengantarLookupVerdict {
    if (result === null) {
        return "missing";
    }

    if (result.isDeleted === true) {
        return "missing";
    }

    return "exists";
}

/**
 * PURE. Interpret a TRACKING-ONLY lookup result. A local resi can be
 * stale, so an empty result is NOT authoritative: it is `uncertain`,
 * never `missing`. Only an explicit `isDeleted:true` proves absence.
 */
export function classifyMengantarTrackingLookup(
    result: { isDeleted?: boolean } | null
): MengantarLookupVerdict {
    if (result === null) {
        return "uncertain";
    }

    if (result.isDeleted === true) {
        return "missing";
    }

    return "exists";
}

/**
 * PURE. Interpret a thrown provider-read error.
 *
 * ONLY an explicit HTTP 404 means "confirmed not found". Credential
 * (401/403), rate-limit (429), server (5xx), timeout, network and
 * malformed-response failures are all uncertain.
 */
export function classifyMengantarLookupError(
    error: unknown
): MengantarLookupVerdict {
    const status = (
        error as { status?: unknown } | null
    )?.status;

    return status === 404 ? "missing" : "uncertain";
}

export type ReconcileCandidate = {
    id: number;
    providerShipmentId: string | null;
    trackingNumber: string | null;
    shipmentStatus: string | null;
};

export type ReconcileResult = {
    orderId: number;
    verdict: MengantarLookupVerdict;
    reconciled: boolean;
    reason?: string;
};

/**
 * Ask Mengantar whether the shipment referenced by this order still
 * exists. Never throws — every failure maps to a verdict.
 *
 * Provider identifier preference:
 *   1. `providerShipmentId` (ORDER_ID) — authoritative, never stale.
 *   2. `trackingNumber` (cnote_no)     — fallback; its absence is
 *      ambiguous, so it can report `exists`/`missing(deleted)` but
 *      NEVER `missing` purely from an empty result.
 */
export async function verifyMengantarShipment(
    order: Pick<
        ReconcileCandidate,
        "providerShipmentId" | "trackingNumber"
    >
): Promise<MengantarLookupVerdict> {
    if (order.providerShipmentId) {
        try {
            const result =
                await getMengantarOrderByOrderId(
                    order.providerShipmentId
                );

            return classifyMengantarLookup(result);
        } catch (error) {
            return classifyMengantarLookupError(error);
        }
    }

    if (order.trackingNumber) {
        try {
            const result =
                await getMengantarOrderByTracking(
                    order.trackingNumber
                );

            return classifyMengantarTrackingLookup(result);
        } catch (error) {
            return classifyMengantarLookupError(error);
        }
    }

    // No provider identifier at all → cannot confirm anything.
    return "uncertain";
}

/**
 * Reconcile ONE order. Returns `reconciled: true` only when this
 * call won the atomic reset and re-queued the job.
 */
export async function reconcileMengantarShipment(
    order: ReconcileCandidate
): Promise<ReconcileResult> {
    const verdict = await verifyMengantarShipment(order);

    if (verdict !== "missing") {
        return { orderId: order.id, verdict, reconciled: false };
    }

    /*
     * Atomic, re-validated reset. The WHERE clause re-checks every
     * hard precondition at write time (paid, non-COD, not cancelled)
     * AND pins the exact providerShipmentId we just verified — so a
     * concurrent create/finalize or a stale read can never race us
     * into dropping a live shipment's identifiers.
     */
    const reset = await prisma.order.updateMany({
        where: {
            id: order.id,
            shippingProvider: "MENGANTAR",
            shipmentStatus: RECONCILE_ELIGIBLE_STATUS,
            providerShipmentId: order.providerShipmentId,
            paymentStatus: "PAID",
            paymentMethod: { not: "COD" },
            status: { not: "CANCELLED" },
        },
        data: {
            shipmentStatus: "SHIPMENT_PENDING",
            providerShipmentId: null,
            providerBatchId: null,
            trackingNumber: null,
            // The seller's shipping payment is re-derived by the new
            // create/pay flow; leaving a stale PAID would misreport.
            shippingPaymentStatus: null,
        },
    });

    if (reset.count === 0) {
        return {
            orderId: order.id,
            verdict,
            reconciled: false,
            reason:
                "State berubah atau pesanan tidak lagi memenuhi syarat.",
        };
    }

    /*
     * Re-queue the durable outbox. Only a non-PROCESSING job may be
     * reset, so an in-flight worker is never clobbered. If no job
     * row exists yet, create one (duplicate-safe).
     */
    const jobReset = await prisma.shipmentJob.updateMany({
        where: {
            orderId: order.id,
            status: {
                in: ["DONE", "FAILED", "PENDING", "CANCELLED"],
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

    if (jobReset.count === 0) {
        await prisma.shipmentJob.createMany({
            data: [{ orderId: order.id }],
            skipDuplicates: true,
        });
    }

    console.warn(
        "MENGANTAR RECONCILE: provider shipment missing — reset to SHIPMENT_PENDING",
        {
            orderId: order.id,
            hadProviderShipmentId: Boolean(
                order.providerShipmentId
            ),
        }
    );

    return { orderId: order.id, verdict, reconciled: true };
}

/**
 * Scan for locally-CREATED Mengantar shipments old enough to be
 * considered stable, and reconcile each. Bounded + fault-isolated:
 * one order's failure never aborts the sweep.
 */
export async function reconcileMengantarShipments({
    limit = 20,
    now = new Date(),
}: {
    limit?: number;
    now?: Date;
} = {}): Promise<{ scanned: number; reconciled: number }> {
    const minAge = new Date(
        now.getTime() - MENGANTAR_RECONCILE_MIN_AGE_MS
    );

    const candidates = await prisma.order.findMany({
        where: {
            shippingProvider: "MENGANTAR",
            shipmentStatus: RECONCILE_ELIGIBLE_STATUS,
            providerShipmentId: { not: null },
            trackingNumber: { not: null },
            paymentStatus: "PAID",
            paymentMethod: { not: "COD" },
            status: { not: "CANCELLED" },
            updatedAt: { lt: minAge },
        },
        orderBy: { updatedAt: "asc" },
        take: Math.max(1, limit),
        select: {
            id: true,
            providerShipmentId: true,
            trackingNumber: true,
            shipmentStatus: true,
        },
    });

    let reconciled = 0;

    for (const candidate of candidates) {
        try {
            const result = await reconcileMengantarShipment(
                candidate
            );

            if (result.reconciled) reconciled++;
        } catch (error) {
            console.error(
                "MENGANTAR RECONCILE ERROR:",
                candidate.id,
                error instanceof Error
                    ? redactMengantarKey(error.message)
                    : "unknown"
            );
        }
    }

    return { scanned: candidates.length, reconciled };
}
