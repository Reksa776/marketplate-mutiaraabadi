/*
 * ============================================================
 * MENGANTAR ADMIN STATUS — PRESENTATION (PURE)
 * ============================================================
 *
 * The admin dashboard (`/admin/orders` list + `/admin/orders/[id]`
 * detail) must show ONE clear "Status Mengantar" per order, so an
 * admin can instantly tell apart:
 *
 *   - PAID, shipment belum dibuat       → "Belum dibuat"
 *   - PAID, shipment sudah dibuat       → "Terbuat" (+ flight)
 *   - shipment hilang di Mengantar
 *     (external deletion, recoverable)  → "Pending" (sedang dibuat ulang)
 *   - shipment dihapus manual dari
 *     marketplace (intentional, terminal) → "Dihapus manual"
 *
 * NO new DB enum is introduced: this maps the EXISTING free-form
 * `Order.shipmentStatus` String values (see lib/mengantar/status.ts)
 * onto a display label + tone. It is PURE (no prisma / no env / no
 * network) so it is safe to import from BOTH the client components
 * and the tests.
 * ============================================================
 */

export type MengantarAdminStatusTone =
    | "neutral"
    | "info"
    | "progress"
    | "success"
    | "warning"
    | "danger";

export type MengantarAdminStatusKind =
    | "NOT_APPLICABLE"
    | "NOT_CREATED"
    | "PENDING"
    | "PROCESSING"
    | "WAITING_PAYMENT"
    | "CREATED"
    | "IN_TRANSIT"
    | "DELIVERED"
    | "RETURNED"
    | "FAILED"
    | "CANCELLED"
    | "DELETED"
    | "UNKNOWN";

export type MengantarAdminStatus = {
    kind: MengantarAdminStatusKind;
    /** Short admin-facing label, e.g. "Belum dibuat". */
    label: string;
    tone: MengantarAdminStatusTone;
    /** Is this order fulfilled by Mengantar at all? */
    isMengantar: boolean;
    /**
     * True while a provider shipment id is STILL persisted locally.
     * Reconcile clears it when the provider no longer has the order,
     * so this reflects the (possibly not-yet-reconciled) local view.
     */
    hasProviderShipment: boolean;
    /** Local resi (cnote_no) when one is persisted, else null. */
    trackingNumber: string | null;
};

/**
 * `Order.shippingProvider === "MENGANTAR"` (case-insensitive). NULL /
 * unknown providers deliberately return false so legacy orders read
 * as "Tidak berlaku" instead of an empty Mengantar state.
 */
export function isMengantarShippingProvider(
    value: unknown
): boolean {
    return (
        typeof value === "string" &&
        value.trim().toUpperCase() === "MENGANTAR"
    );
}

type StatusDescriptor = {
    kind: MengantarAdminStatusKind;
    label: string;
    tone: MengantarAdminStatusTone;
};

/*
 * The single display table. Every value here is an EXISTING
 * `shipmentStatus` produced by lib/mengantar/status.ts and the
 * shipment/reconcile flows — no provider raw category ever leaks in.
 *
 * `DELETED` is the persistent "no longer active" state used ONLY for an
 * INTENTIONAL deletion FROM THE MARKETPLACE (the admin 🗑️ action).
 * Reconcile/cron and the worker NEVER auto-recreate it; an admin can
 * still recreate manually. A provider `isDeleted:true` is NOT mapped
 * here — it is an EXTERNAL (recoverable) deletion that reconcile turns
 * back into `SHIPMENT_PENDING`.
 */
const STATUS_TABLE: Record<string, StatusDescriptor> = {
    NOT_CREATED: {
        kind: "NOT_CREATED",
        label: "Belum dibuat",
        tone: "neutral",
    },
    SHIPMENT_PENDING: {
        kind: "PENDING",
        label: "Pending",
        tone: "info",
    },
    CREATING: {
        kind: "PROCESSING",
        label: "Processing",
        tone: "progress",
    },
    PAYING: {
        kind: "PROCESSING",
        label: "Processing",
        tone: "progress",
    },
    WAITING_SHIPPING_PAYMENT: {
        kind: "WAITING_PAYMENT",
        label: "Menunggu bayar ongkir",
        tone: "warning",
    },
    FAILED: {
        kind: "FAILED",
        label: "Gagal",
        tone: "danger",
    },
    SHIPPING_PAID: {
        kind: "CREATED",
        label: "Terbuat",
        tone: "success",
    },
    CREATED: {
        kind: "CREATED",
        label: "Terbuat",
        tone: "success",
    },
    PICKED_UP: {
        kind: "IN_TRANSIT",
        label: "Diambil kurir",
        tone: "success",
    },
    IN_TRANSIT: {
        kind: "IN_TRANSIT",
        label: "Dikirim",
        tone: "success",
    },
    UNDELIVERED: {
        kind: "IN_TRANSIT",
        label: "Gagal antar",
        tone: "warning",
    },
    DELIVERED: {
        kind: "DELIVERED",
        label: "Terkirim",
        tone: "success",
    },
    RETURNED: {
        kind: "RETURNED",
        label: "Dikembalikan",
        tone: "warning",
    },
    CANCELLED: {
        kind: "CANCELLED",
        label: "Dibatalkan",
        tone: "danger",
    },
    DELETED: {
        kind: "DELETED",
        label: "Dihapus manual (terminal)",
        tone: "danger",
    },
};

const NOT_APPLICABLE: StatusDescriptor = {
    kind: "NOT_APPLICABLE",
    label: "Tidak berlaku",
    tone: "neutral",
};

const NOT_CREATED: StatusDescriptor = {
    kind: "NOT_CREATED",
    label: "Belum dibuat",
    tone: "neutral",
};

/**
 * Resolve the admin-facing Mengantar status for an order-like object.
 * Accepts a partial shape so it can run against the list API payload,
 * the detail payload, or a plain DB row.
 */
export function resolveMengantarAdminStatus(order: {
    shippingProvider?: string | null;
    shipmentStatus?: string | null;
    providerShipmentId?: string | null;
    trackingNumber?: string | null;
}): MengantarAdminStatus {
    const isMengantar = isMengantarShippingProvider(
        order.shippingProvider
    );

    const trackingNumber = order.trackingNumber
        ? String(order.trackingNumber).trim() || null
        : null;

    if (!isMengantar) {
        return {
            ...NOT_APPLICABLE,
            isMengantar: false,
            hasProviderShipment: false,
            trackingNumber: null,
        };
    }

    const raw = String(order.shipmentStatus ?? "")
        .trim()
        .toUpperCase();

    const descriptor =
        raw === ""
            ? NOT_CREATED
            : STATUS_TABLE[raw] ?? {
                  kind: "UNKNOWN" as const,
                  label: raw,
                  tone: "neutral" as const,
              };

    return {
        kind: descriptor.kind,
        label: descriptor.label,
        tone: descriptor.tone,
        isMengantar: true,
        hasProviderShipment: Boolean(
            order.providerShipmentId
        ),
        trackingNumber,
    };
}
