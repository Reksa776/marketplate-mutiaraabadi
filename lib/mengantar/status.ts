/*
 * ============================================================
 * MENGANTAR SHIPMENT STATUS — SINGLE MAPPING SOURCE OF TRUTH
 * ============================================================
 *
 * Provider `status_category` strings MUST NOT leak across the
 * codebase. Every consumer (webhook, admin UI, notification hook,
 * shipment library) resolves them through this pure module.
 *
 * Contract source: https://api-public.mengantar.com/docs/
 *   Courier categories:
 *     PENDING PICKUP, PICKED UP, ON DELIVERY, DELIVERED,
 *     UNDELIVERED, PICKUP FAILED, RTS
 *   Internal Mengantar categories (informational):
 *     ACTIVE/WAITING NEXT PROCESS, ERROR
 *   Cancellation is spelled BOTH `CANCELED` and `CANCELLED`.
 *
 * This module is PURE (no prisma / no env) so it is safe to import
 * from anywhere, including tests.
 * ============================================================
 */

export const MENGANTAR_SHIPMENT_STATUSES = [
    "NOT_CREATED",
    // Enqueued for automatic creation (payment authoritatively PAID).
    // A durable outbox job exists and the worker will claim it.
    "SHIPMENT_PENDING",
    "CREATING",
    "WAITING_SHIPPING_PAYMENT",
    "PAYING",
    "SHIPPING_PAID",
    "CREATED",
    "PICKED_UP",
    "IN_TRANSIT",
    "UNDELIVERED",
    "DELIVERED",
    "RETURNED",
    "CANCELLED",
] as const;

export type MengantarShipmentStatus =
    (typeof MENGANTAR_SHIPMENT_STATUSES)[number];

/**
 * Internal shipment statuses that are terminal — no further
 * transition may be applied once reached.
 */
const TERMINAL_SHIPMENT_STATUSES = new Set<string>([
    "DELIVERED",
    "RETURNED",
    "CANCELLED",
]);

/**
 * Forward-progress rank. A lower rank may never overwrite a higher
 * rank (e.g. DELIVERED must not become CREATED again).
 */
const SHIPMENT_STATUS_RANK: Record<string, number> = {
    NOT_CREATED: 0,
    SHIPMENT_PENDING: 1,
    CREATING: 1,
    WAITING_SHIPPING_PAYMENT: 1,
    PAYING: 1,
    CREATED: 2,
    SHIPPING_PAID: 2,
    PICKED_UP: 3,
    IN_TRANSIT: 4,
    UNDELIVERED: 5,
    DELIVERED: 6,
    RETURNED: 7,
    CANCELLED: 8,
};

/**
 * Map a raw Mengantar `status_category` (or internal status already
 * stored) to our internal shipment status.
 *
 * Returns null for unknown / non-actionable categories so callers
 * leave the existing state untouched instead of destroying it.
 * Case/space tolerant — never assumes a fixed casing.
 */
export function mapMengantarShipmentStatus(
    providerStatus: unknown
): MengantarShipmentStatus | null {
    const value = String(providerStatus ?? "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, " ");

    switch (value) {
        case "PENDING PICKUP":
            return "CREATED";
        case "PICKED UP":
            return "PICKED_UP";
        case "ON DELIVERY":
        case "IN TRANSIT":
        case "IN_TRANSIT":
            return "IN_TRANSIT";
        case "DELIVERED":
            return "DELIVERED";
        case "UNDELIVERED":
            return "UNDELIVERED";
        // A failed pickup leaves the parcel at the origin — it is
        // still a CREATED (not yet picked up) shipment.
        case "PICKUP FAILED":
            return "CREATED";
        case "RTS":
        case "RETURNED":
        case "RETURN TO SENDER":
            return "RETURNED";
        case "CANCELED":
        case "CANCELLED":
            return "CANCELLED";
        // Internal Mengantar categories are informational only.
        case "ACTIVE/WAITING NEXT PROCESS":
        case "ERROR":
            return null;
        default:
            return null;
    }
}

export type ShipmentTransitionDecision = {
    allowed: boolean;
    reason:
        | "ok"
        | "unknown_status"
        | "no_change"
        | "terminal"
        | "backwards";
};

/**
 * Decide whether an incoming provider status may be applied over the
 * currently-stored internal shipment status.
 *
 * Rules:
 *   - unknown provider status         → rejected (state preserved)
 *   - identical status                → no_change (idempotent no-op)
 *   - current status is terminal      → rejected
 *   - incoming rank < current rank    → rejected (no backwards moves)
 */
export function decideMengantarShipmentTransition(
    currentStatus: unknown,
    providerStatus: unknown
): ShipmentTransitionDecision & {
    nextStatus: MengantarShipmentStatus | null;
} {
    const nextStatus =
        mapMengantarShipmentStatus(providerStatus);

    if (!nextStatus) {
        return { allowed: false, reason: "unknown_status", nextStatus: null };
    }

    const current = String(currentStatus ?? "")
        .trim()
        .toUpperCase();

    if (current && current === nextStatus) {
        return { allowed: false, reason: "no_change", nextStatus };
    }

    if (current && TERMINAL_SHIPMENT_STATUSES.has(current)) {
        return { allowed: false, reason: "terminal", nextStatus };
    }

    const currentRank = SHIPMENT_STATUS_RANK[current] ?? -1;
    const nextRank = SHIPMENT_STATUS_RANK[nextStatus] ?? -1;

    if (nextRank < currentRank) {
        return { allowed: false, reason: "backwards", nextStatus };
    }

    // A parcel that is already with the courier (picked up or beyond)
    // can no longer be cancelled — cancellation is only possible
    // before pickup.
    if (
        nextStatus === "CANCELLED" &&
        currentRank >= SHIPMENT_STATUS_RANK.PICKED_UP
    ) {
        return { allowed: false, reason: "backwards", nextStatus };
    }

    return { allowed: true, reason: "ok", nextStatus };
}

/**
 * Notification event key for a shipment status. Uses a distinct
 * `SHIPMENT_*` namespace so shipment notifications never collide
 * with order-status notifications in the shared notification
 * idempotency key (`notif_order_{id}_{prev}_{new}`).
 */
export function shipmentStatusToEventKey(
    status: unknown
): string | null {
    switch (
        String(status ?? "")
            .trim()
            .toUpperCase()
    ) {
        case "WAITING_SHIPPING_PAYMENT":
            return "SHIPPING_PAYMENT_REQUIRED";
        // SHIPMENT_PENDING is a transient enqueued state → silent.
        case "SHIPMENT_PENDING":
            return null;
        case "CREATED":
        case "SHIPPING_PAID":
            return "SHIPMENT_CREATED";
        case "PICKED_UP":
            return "SHIPMENT_PICKED_UP";
        case "IN_TRANSIT":
            return "SHIPMENT_IN_TRANSIT";
        case "DELIVERED":
            return "SHIPMENT_DELIVERED";
        case "UNDELIVERED":
            return "SHIPMENT_UNDELIVERED";
        case "RETURNED":
            return "SHIPMENT_RETURNED";
        case "CANCELLED":
            return "SHIPMENT_CANCELLED";
        default:
            return null;
    }
}
