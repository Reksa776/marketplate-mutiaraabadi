import type {
    Order_status,
    PrismaClient,
} from "@prisma/client";

type DbClient = PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * ==========================================
 * COD ABUSE POLICY
 * ==========================================
 *
 * Cash-on-delivery is the highest-abuse payment surface for a
 * guest-only storefront: there is no prepayment, and the order is
 * handed straight to the Mengantar auto-shipment pipeline.
 *
 * POLICY
 * ------
 * 1. HIGH-RISK ORDERS ARE HELD, NOT CANCELLED. When an order is
 *    flagged, a durable ShipmentJob is still NOT enqueued until an
 *    admin approves it. The order keeps its normal
 *    `paymentStatus = UNPAID` lifecycle — flagging never marks a COD
 *    order PAID and never auto-cancels a legitimate order.
 * 2. A GUEST IS CAPPED on concurrently-open COD orders. Repeated COD
 *    orders that are never collected are the classic (and cheapest)
 *    way to abuse this flow.
 * 3. Thresholds are configurable per deployment, with conservative
 *    defaults, so production can be tuned without a code change.
 *
 * NOT in scope for this phase (deliberately): OTP verification and any
 * requirement that the customer sign in.
 */

/** Order value (IDR) at/above which a COD order needs admin review. */
export const COD_REVIEW_AMOUNT_THRESHOLD = readIntEnv(
    "COD_REVIEW_AMOUNT_THRESHOLD",
    2_000_000
);

/** Max concurrently-open COD orders per guest identity. */
export const COD_MAX_ACTIVE_GUEST_ORDERS = readIntEnv(
    "COD_MAX_ACTIVE_GUEST_ORDERS",
    3
);

/**
 * Orders in these statuses still consume a slot in the guest's
 * open-COD allowance: they are neither finished nor cancelled.
 */
export const COD_ACTIVE_STATUSES: Order_status[] = [
    "PENDING",
    "PAID",
    "PROCESSING",
    "SHIPPED",
];

/**
 * Shipment states that mean "this COD order is FINISHED".
 *
 * WHY THIS EXISTS: the Mengantar fulfilment pipeline deliberately
 * never writes `Order.status` — the shipping lifecycle lives in
 * `shipmentStatus` (see lib/mengantar/shipment.ts). A COD order that
 * was shipped and confirmed delivered therefore keeps
 * `status = PENDING` unless an admin moves it by hand, so counting
 * `COD_ACTIVE_STATUSES` alone meant a DELIVERED parcel occupied the
 * buyer's open-COD allowance FOREVER. A legitimate repeat buyer then
 * hit the cap and had every later order held for review — the very
 * regression this constant fixes.
 *
 * Deliberately CONSERVATIVE: only a CONFIRMED DELIVERED parcel is
 * released. UNDELIVERED / RETURNED / CANCELLED shipments keep counting,
 * because a parcel that came back is exactly the signal this quota
 * exists to catch.
 */
export const COD_QUOTA_RELEASED_SHIPMENT_STATUSES = [
    "DELIVERED",
] as const;

function readIntEnv(
    name: string,
    fallback: number
): number {
    const raw = process.env[name];

    if (!raw) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);

    if (
        !Number.isInteger(parsed) ||
        parsed < 0
    ) {
        console.warn(
            `[COD_POLICY] Ignoring invalid ${name}=${raw}; using ${fallback}.`
        );
        return fallback;
    }

    return parsed;
}

export type CodRiskAssessment = {
    /** true → hold the shipment until an admin approves */
    requiresReview: boolean;
    /** machine-readable reasons, stored for the admin review queue */
    reasons: string[];
};

/**
 * Pure risk assessment — no I/O, so it is trivially testable.
 */
export function assessCodRisk(input: {
    total: number;
    /** open COD orders already owned by this device/identity */
    activeCodOrders: number;
    /** true when there is no authenticated session */
    isGuest: boolean;
}): CodRiskAssessment {
    const reasons: string[] = [];

    if (
        COD_REVIEW_AMOUNT_THRESHOLD > 0 &&
        input.total >= COD_REVIEW_AMOUNT_THRESHOLD
    ) {
        reasons.push("HIGH_VALUE");
    }

    if (
        input.isGuest &&
        COD_MAX_ACTIVE_GUEST_ORDERS > 0 &&
        input.activeCodOrders >=
            COD_MAX_ACTIVE_GUEST_ORDERS
    ) {
        reasons.push("TOO_MANY_OPEN_COD");
    }

    return {
        requiresReview: reasons.length > 0,
        reasons,
    };
}

/**
 * Count the COD orders still open for a guest identity scope.
 *
 * `ownerKey` here is the same identity scope used by the voucher /
 * flash-sale caps (see lib/guest-identity.ts), so it survives cookie
 * clearing — unlike a device-only counter.
 */
export async function countActiveGuestCodOrders(
    client: DbClient,
    guestIdentityKey: string
): Promise<number> {
    return client.order.count({
        where: {
            guestIdentityKey,
            paymentMethod: "COD",
            status: {
                in: COD_ACTIVE_STATUSES,
            },

            /*
             * A confirmed delivery releases the slot.
             *
             * NULL-SAFE ON PURPOSE: `notIn` alone would DROP every row
             * whose shipmentStatus is NULL, because SQL three-valued
             * logic evaluates `NULL NOT IN (...)` to NULL (not TRUE).
             * Legacy / non-Mengantar COD orders have exactly that NULL,
             * so they must be listed explicitly or the quota would
             * silently stop counting them.
             */
            OR: [
                { shipmentStatus: null },
                {
                    shipmentStatus: {
                        notIn: [
                            ...COD_QUOTA_RELEASED_SHIPMENT_STATUSES,
                        ],
                    },
                },
            ],
        },
    });
}
