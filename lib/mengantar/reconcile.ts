import { prisma } from "@/lib/prisma";
import {
    getMengantarOrderByOrderId,
    getMengantarOrderByTracking,
    redactMengantarKey,
} from "@/lib/mengantar";
import { createAuditLog } from "@/lib/admin/audit-log";

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
 * VERIFIED PROVIDER BEHAVIOR (real API, observed):
 *   A shipment deleted from the Mengantar dashboard is NOT returned as
 *   a 404 / empty result. The authoritative lookup by `order_id`
 *   returns HTTP 200 with the row STILL PRESENT and:
 *       isDeleted: true, deletedAt: "<iso>", status: "active"
 *   The tracking (resi) lookup is the one that comes back empty.
 *
 * So the source of truth for INTENTIONAL deletion is the LOCAL state,
 * NOT the provider flag:
 *
 *   LOCAL `shipmentStatus = "DELETED"`  → intentional, terminal.
 *       Set ONLY by a marketplace-internal action (the admin 🗑️ delete
 *       flow). Reconcile and the worker NEVER auto-recreate it.
 *
 *   LOCAL `shipmentStatus = "CREATED"` + provider `isDeleted:true`
 *       (or a confirmed missing 404 / empty authoritative lookup)
 *       → EXTERNAL deletion, RECOVERABLE. This is human error, not a
 *       business decision, so we clear the stale identifiers and
 *       re-queue a fresh shipment.
 *
 * RECOVERY FLOW (external deletion):
 *
 *   CREATED → provider says gone (isDeleted OR missing)
 *           → clear providerShipmentId / providerBatchId / trackingNumber
 *           → shipmentStatus = SHIPMENT_PENDING (existing recreate state)
 *           → ShipmentJob PENDING → worker → POST /order → CREATED
 *
 * SAFETY (hard rules):
 *   - `shippingProvider` = "MENGANTAR", `paymentStatus` = PAID and
 *     non-COD are ALL required. COD never self-heals.
 *   - A LOCAL `DELETED` order is left untouched (terminates immediately;
 *     the provider is not even queried).
 *   - A provider read that is NOT a confirmed "gone" (401/403
 *     credential, 429 rate limit, 5xx, timeout, network error,
 *     malformed response) is treated as UNCERTAIN and NEVER triggers
 *     a reset.
 *   - Every write is an atomic CAS on the exact `CREATED` +
 *     `providerShipmentId` we verified, so concurrent reconcilers
 *     cannot double-reset, and the existing worker claim remains the
 *     single gate before any `POST /order`.
 *   - NEVER writes Order.paymentStatus.
 * ============================================================
 */

/**
 * Safe, non-credential audit event emitted when Mengantar reports a
 * shipment as externally deleted (`isDeleted:true`). Stored via the
 * existing AdminAuditLog and also logged. NEVER carries a provider
 * credential.
 */
export const MENGANTAR_SHIPMENT_DELETED_EXTERNALLY =
    "MENGANTAR_SHIPMENT_DELETED_EXTERNALLY";

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

/** Local intentional deletion — never auto-recreated. */
const LOCAL_TERMINAL_DELETED = "DELETED";

export type MengantarLookupVerdict =
    | "exists"
    /** Provider confirms the shipment is gone (empty 404 lookup) → recover. */
    | "missing"
    /** Provider flags `isDeleted:true` → external deletion → recover. */
    | "deleted"
    | "uncertain";

/**
 * PURE. Interpret an AUTHORITATIVE lookup result (by providerShipmentId
 * / ORDER_ID). The official GET /order documents `order_id` as a
 * unique lookup, and the real provider response is:
 *
 *   null                          → provider has no such order → "missing"
 *   entry with isDeleted:true     → dashboard/external deletion → "deleted"
 *   any other returned entry      → it still exists            → "exists"
 *
 * BOTH "missing" and "deleted" are RECOVERABLE and take the same
 * recovery path. A returned row WITHOUT the flag is always "exists"
 * (never reset), so this fails safe towards not touching live data.
 */
export function classifyMengantarLookup(
    result: { isDeleted?: boolean } | null
): MengantarLookupVerdict {
    if (result === null) {
        return "missing";
    }

    if (result.isDeleted === true) {
        return "deleted";
    }

    return "exists";
}

/**
 * PURE. Interpret a TRACKING-ONLY lookup result. A local resi can be
 * stale, so an empty result is NOT authoritative: it is `uncertain`,
 * never `missing` (a wrong resi must never cause a duplicate create).
 * An explicit `isDeleted:true` IS decisive — it means the provider
 * removed the order, which is recoverable.
 */
export function classifyMengantarTrackingLookup(
    result: { isDeleted?: boolean } | null
): MengantarLookupVerdict {
    if (result === null) {
        return "uncertain";
    }

    if (result.isDeleted === true) {
        return "deleted";
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
    verdict: MengantarLookupVerdict | "local_deleted";
    reconciled: boolean;
    /** Only the external-deletion recovery path changes an order. */
    action?: "recreated";
    reason?: string;
};

/**
 * Ask Mengantar whether the shipment referenced by this order still
 * exists. Never throws — every failure maps to a verdict.
 *
 * Provider identifier preference:
 *   1. `providerShipmentId` (ORDER_ID) — authoritative, never stale.
 *   2. `trackingNumber` (cnote_no)     — fallback; its absence is
 *      ambiguous, so it can report `exists`/`deleted` but NEVER
 *      `missing` (recreate) purely from an empty result.
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
 * RECOVERY — the provider no longer has the shipment (external
 * deletion via `isDeleted:true`, or a confirmed missing lookup).
 *
 * The stale identifiers are cleared and the order reset to the
 * existing `SHIPMENT_PENDING` recreate state, then the durable outbox
 * is re-queued so the EXISTING worker creates a fresh shipment. No
 * provider call is made here — the worker owns that, behind its CAS
 * claim, so repeated reconcile passes can never double-create.
 *
 * The atomic CAS pins the exact `CREATED` + `providerShipmentId` we
 * verified. This is ALSO what keeps a LOCAL `DELETED` order terminal:
 * its `shipmentStatus` is no longer `CREATED`, so the WHERE never
 * matches and nothing is reset or enqueued.
 */
async function recoverMengantarShipment(
    order: ReconcileCandidate,
    verdict: "missing" | "deleted"
): Promise<ReconcileResult> {
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

    /*
     * Safe audit trail for an EXPLICIT provider deletion — only the
     * local order id, never a provider credential, key, or raw
     * provider payload. A plain missing lookup relies on the warn log.
     */
    if (verdict === "deleted") {
        await createAuditLog({
            adminId: "SYSTEM",
            action: MENGANTAR_SHIPMENT_DELETED_EXTERNALLY,
            entityType: "Order",
            entityId: order.id,
            description:
                "Mengantar menandai shipment isDeleted:true (external deletion) — data lokal dibersihkan dan shipment baru dijadwalkan.",
            metadata: {
                orderId: order.id,
                event: MENGANTAR_SHIPMENT_DELETED_EXTERNALLY,
                recoverable: true,
                hadProviderShipmentId: Boolean(
                    order.providerShipmentId
                ),
            },
        });
    }

    console.warn(
        "MENGANTAR RECONCILE: provider shipment gone — reset to SHIPMENT_PENDING",
        {
            orderId: order.id,
            verdict,
            hadProviderShipmentId: Boolean(
                order.providerShipmentId
            ),
        }
    );

    return {
        orderId: order.id,
        verdict,
        reconciled: true,
        action: "recreated",
    };
}

/**
 * Reconcile ONE order.
 *
 *   local DELETED                    → terminal, stop (no provider read)
 *   provider exists                  → no-op
 *   provider gone (isDeleted/missing) → recover: clear + re-queue
 *
 * Returns `reconciled: true` only when this call actually changed the
 * order.
 */
export async function reconcileMengantarShipment(
    order: ReconcileCandidate
): Promise<ReconcileResult> {
    /*
     * LOCAL TERMINAL DELETION — the marketplace itself decided this
     * shipment must not exist. This is the ONLY source of truth for an
     * intentional deletion, so STOP immediately: no provider read, no
     * clear, no enqueue. Local `DELETED` is never confused with a
     * provider `isDeleted:true`.
     */
    const localStatus = String(
        order.shipmentStatus ?? ""
    )
        .trim()
        .toUpperCase();

    if (localStatus === LOCAL_TERMINAL_DELETED) {
        return {
            orderId: order.id,
            verdict: "local_deleted",
            reconciled: false,
            reason:
                "Shipment dihapus manual dari marketplace (terminal); tidak dibuat ulang otomatis.",
        };
    }

    const verdict = await verifyMengantarShipment(order);

    // Provider still has it, or the read was inconclusive → no-op.
    if (verdict !== "missing" && verdict !== "deleted") {
        return { orderId: order.id, verdict, reconciled: false };
    }

    // External deletion (isDeleted OR confirmed missing) → recover.
    return recoverMengantarShipment(order, verdict);
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
            // Only CREATED is eligible; a LOCAL `DELETED` order is
            // terminal and is never a candidate.
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
