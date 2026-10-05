import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/admin/audit-log";

import {
    MengantarError,
    createMengantarOrder,
    payMengantarUnpaid,
    toInternalCourier,
    toMengantarCourier,
    type MengantarCourier,
} from "@/lib/mengantar";
import {
    buildMengantarShippingOptions,
    getMengantarOriginConfig,
    resolveMengantarDestinationAreaId,
} from "@/lib/mengantar/shipping";
import {
    resolveMengantarPickupSchedule,
    type ResolvedMengantarPickup,
} from "@/lib/mengantar/pickup-schedule";

/*
 * ============================================================
 * MENGANTAR SHIPMENT LIFECYCLE — SERVER-ONLY
 * ============================================================
 *
 * createShipmentForOrder():
 *   POST /order → ORDER_ID + batch_id + cnote_no
 *   Balance insufficient → isPaid:false, cnote_no:null
 *   → shipmentStatus = WAITING_SHIPPING_PAYMENT (NOT shipped, NO fake
 *     tracking, order stays paid if the customer already paid).
 *
 * payUnpaidShipmentForOrder():
 *   POST /order/pay-unpaid → generates cnote_no, creates the shipment.
 *
 * PAYMENT SEPARATION (hard rule):
 *   These functions NEVER touch Order.paymentStatus. The customer's
 *   marketplace payment and the seller's shipping payment to Mengantar
 *   are independent state machines.
 * ============================================================
 */

const SHIPMENT_ALREADY_CREATED = new Set([
    "SHIPPING_PAID",
    "CREATED",
    "PICKED_UP",
    "IN_TRANSIT",
    "DELIVERED",
    "RETURNED",
    // A balance-insufficient shipment was already accepted by
    // Mengantar — a duplicate create must NOT post a second order.
    "WAITING_SHIPPING_PAYMENT",
]);

/**
 * How long a transient DB claim (CREATING / PAYING) may block a
 * retry before it is considered abandoned (e.g. the process crashed
 * between claiming and calling Mengantar).
 */
const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Release a transient claim only if it is still held by us.
 * Used to roll back to a retryable state when the provider call
 * fails or is rejected, so the admin can try again.
 */
async function releaseShipmentClaim(
    orderId: number,
    from: string,
    to: string
): Promise<void> {
    await prisma.order.updateMany({
        where: { id: orderId, shipmentStatus: from },
        data: { shipmentStatus: to },
    });
}

export type ShipmentActionResult = {
    ok: boolean;
    /** True only when this call actually changed the shipment state. */
    changed?: boolean;
    reason?: string;
    shipmentStatus?: string | null;
    shippingPaymentStatus?: string | null;
    trackingNumber?: string | null;
    batchId?: string | null;
    shipmentId?: string | null;
    /** Resolved pickup schedule (persisted by the worker on the job). */
    pickupSchedule?: { date: string; time: string } | null;
};

function toKilograms(grams: number): number {
    return Math.max(1, Math.ceil(Number(grams)) / 1000);
}

/**
 * Total order weight (kg) from the persisted variants, and total item
 * quantity. No customProducts are sent, so Mengantar's
 * weight=Σ qty×weight invariant only needs the aggregate weight.
 */
async function loadOrderWeight(orderId: number): Promise<{
    weightGrams: number;
    weightKg: number;
    quantity: number;
    parcelContent: string;
}> {
    const items = await prisma.orderItem.findMany({
        where: { orderId },
        select: {
            productName: true,
            variantName: true,
            quantity: true,
            variant: { select: { weight: true } },
        },
    });

    if (items.length === 0) {
        throw new MengantarError(
            "Pesanan tidak memiliki item."
        );
    }

    let grams = 0;
    let quantity = 0;

    for (const item of items) {
        const qty = Number(item.quantity) || 0;
        quantity += qty;
        // Variant may have been deleted (SetNull) — fall back to a
        // 1 kg minimum per line so the shipment can still be created.
        const rawWeight = item.variant?.weight
            ? Number(item.variant.weight)
            : 1000;
        grams +=
            Math.round(
                Number.isFinite(rawWeight) && rawWeight > 0
                    ? rawWeight
                    : 1000
            ) * qty;
    }

    const parcelContent = items
        .map((i) =>
            i.variantName
                ? `${i.productName} - ${i.variantName}`
                : i.productName
        )
        .join(", ")
        .slice(0, 200);

    return {
        weightGrams: grams,
        weightKg: toKilograms(grams),
        quantity: Math.max(1, quantity),
        parcelContent,
    };
}

/**
 * Normalize a phone number to Mengantar's 10–15 digit rule (no spaces
 * or dashes). Returns null when the phone cannot be normalized.
 */
function normalizePhone(value: unknown): string | null {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15
        ? digits
        : null;
}

export async function createShipmentForOrder(
    orderId: number,
    /**
     * Admin manual recovery may recreate an intentionally DELETED
     * shipment. The automatic worker must NEVER pass this — an
     * intentionally deleted shipment stays deleted unless a human
     * explicitly asks.
     */
    options: { allowDeleted?: boolean } = {}
): Promise<ShipmentActionResult> {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            orderNumber: true,
            status: true,
            recipientName: true,
            phone: true,
            address: true,
            province: true,
            city: true,
            district: true,
            postalCode: true,
            paymentMethod: true,
            paymentStatus: true,
            shippingProvider: true,
            providerCourier: true,
            providerShipmentId: true,
            providerBatchId: true,
            shipmentStatus: true,
            shippingPaymentStatus: true,
            trackingNumber: true,
            total: true,
            shippingCost: true,
            codAmount: true,
        },
    });

    if (!order) {
        return { ok: false, reason: "Pesanan tidak ditemukan." };
    }

    if (order.shippingProvider !== "MENGANTAR") {
        return {
            ok: false,
            reason:
                "Pesanan ini tidak menggunakan pengiriman Mengantar.",
        };
    }

    /*
     * ---- Cancellation / money-returned guard ----
     *
     * An order whose customer payment is REFUNDED, or that has been
     * CANCELLED, must NEVER get a shipment created. This preserves
     * the separation between the shipping state machine and the
     * money-returned flow: that flow never has to know about
     * shipments, and the shipment flow never resurrects a REFUNDED
     * order.
     */
    if (
        order.status === "CANCELLED" ||
        order.paymentStatus === "REFUNDED"
    ) {
        return {
            ok: false,
            changed: false,
            reason:
                "Pesanan sudah dibatalkan atau dana dikembalikan; shipment tidak dibuat.",
            shipmentStatus: order.shipmentStatus ?? null,
        };
    }

    /*
     * Intentional admin deletion. Only an explicit admin recovery
     * (`allowDeleted`) may recreate; the automatic worker is refused so
     * a click on 🗑️ can never be undone by a cron/worker race.
     */
    if (
        order.shipmentStatus === "DELETED" &&
        !options.allowDeleted
    ) {
        return {
            ok: false,
            changed: false,
            reason:
                "Shipment sudah dihapus manual oleh admin. Buat ulang lewat tombol Buat Shipment bila memang diinginkan.",
            shipmentStatus: "DELETED",
        };
    }

    // ---- Idempotency / duplicate protection ----
    if (
        order.providerShipmentId ||
        (order.shipmentStatus &&
            SHIPMENT_ALREADY_CREATED.has(order.shipmentStatus))
    ) {
        return {
            ok: true,
            changed: false,
            reason: "Shipment sudah dibuat.",
            shipmentStatus: order.shipmentStatus ?? "CREATED",
            shippingPaymentStatus:
                order.shippingPaymentStatus ?? "UNPAID",
            trackingNumber: order.trackingNumber,
            batchId: order.providerBatchId,
            shipmentId: order.providerShipmentId,
        };
    }

    const courier = toMengantarCourier(
        order.providerCourier
    );

    if (!courier) {
        return {
            ok: false,
            reason:
                "Kurir Mengantar pada pesanan ini tidak valid.",
        };
    }

    const pickup = await getMengantarOriginConfig();

    if (!pickup) {
        return {
            ok: false,
            reason:
                "Konfigurasi pickup Mengantar belum diatur di pengaturan toko.",
        };
    }

    const destinationAreaId =
        await resolveMengantarDestinationAreaId({
            mengantarDestinationAreaId: null,
            province: order.province,
            city: order.city,
            district: order.district,
            postalCode: order.postalCode,
        });

    if (!destinationAreaId) {
        return {
            ok: false,
            reason:
                "Alamat tujuan belum dapat dipetakan ke area Mengantar.",
        };
    }

    const phone = normalizePhone(order.phone);

    if (!phone) {
        return {
            ok: false,
            reason:
                "Nomor HP penerima tidak valid (10–15 digit).",
        };
    }

    const { weightGrams, weightKg, quantity, parcelContent } =
        await loadOrderWeight(order.id);

    const isCod = order.paymentMethod === "COD";

    /*
     * ---- COD courier resolution (per courier + destination) ----
     *
     * Mengantar reports COD capability per courier in the SAME
     * estimate that reports destination availability:
     *   unsupported: true       → courier does not serve the area
     *   unsupported_cod: false  → courier accepts COD for it
     *
     * `buildMengantarShippingOptions` is the project's single
     * normalizer for exactly those two provider flags (it drops
     * unsupported entries and exposes `supportsCod`), so it is the
     * source of truth for "which couriers can carry this COD parcel".
     *
     * The customer may have chosen a courier that serves the
     * destination only for PREPAID. For COD we keep their choice when
     * it genuinely supports COD; otherwise we resolve to another
     * available COD courier (cheapest first — the UI's default
     * ordering) and use it for the provider POST AND the persisted
     * courier state, so the UI/admin never shows a different courier
     * from the one actually sent. Only when NO courier supports COD
     * do we fail — and we never POST in that case.
     *
     * COD only: the NON-COD branch below is untouched.
     */
    let resolvedCourier = courier;

    if (isCod) {
        const codOptions = (
            await buildMengantarShippingOptions({
                address: {
                    province: order.province,
                    city: order.city,
                    district: order.district,
                    postalCode: order.postalCode,
                    mengantarDestinationAreaId: destinationAreaId,
                },
                weightGrams,
                codAmount: order.codAmount
                    ? Number(order.codAmount)
                    : undefined,
            })
        ).filter((option) => option.supportsCod);

        const chosen =
            codOptions.find(
                (option) => option.courier === courier
            ) ?? codOptions[0];

        if (!chosen) {
            return {
                ok: false,
                changed: false,
                reason:
                    "Kurir tidak melayani tujuan ini untuk COD.",
                shipmentStatus: order.shipmentStatus ?? null,
            };
        }

        resolvedCourier = chosen.courier;
    }

    const goodsValue = Math.max(
        0,
        Number(order.total) - Number(order.shippingCost)
    );

    const orderPayload = {
        customerAddressDataId: destinationAreaId,
        customerAddress: order.address,
        customerName: order.recipientName,
        customerPhone: phone,
        parcelContent: parcelContent || order.orderNumber,
        weight: weightKg,
        quantity,
        ...(isCod
            ? { COD: Number(order.codAmount) || goodsValue }
            : { goodsValue }),
    };

    /*
     * ---- Race guard: atomic DB claim ----
     *
     * Mengantar's POST /order is NOT idempotent (and JT Premium /
     * SiCepat return HTTP 409 when a batch is already in flight). Two
     * concurrent admin clicks would otherwise create two provider
     * shipments. Only one caller may move NOT_CREATED/FAILED → CREATING.
     * A stale CREATING (crashed process) becomes retryable again.
     */
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);

    const claimableStatuses = options.allowDeleted
        ? [
              "NOT_CREATED",
              "SHIPMENT_PENDING",
              "FAILED",
              "DELETED",
          ]
        : ["NOT_CREATED", "SHIPMENT_PENDING", "FAILED"];

    const claim = await prisma.order.updateMany({
        where: {
            id: order.id,
            shippingProvider: "MENGANTAR",
            providerShipmentId: null,
            OR: [
                { shipmentStatus: null },
                {
                    shipmentStatus: {
                        in: claimableStatuses,
                    },
                },
                {
                    shipmentStatus: "CREATING",
                    updatedAt: { lt: staleBefore },
                },
            ],
        },
        data: {
            shipmentStatus: "CREATING",
            /*
             * COD courier re-resolution: persist the courier we are
             * about to POST so the UI/admin (and any notification)
             * shows the SAME courier the provider receives. NON-COD
             * never takes this branch (resolvedCourier === courier).
             */
            ...(isCod && resolvedCourier !== courier
                ? {
                      providerCourier: resolvedCourier,
                      shippingCourier:
                          toInternalCourier(resolvedCourier),
                  }
                : {}),
        },
    });

    if (claim.count === 0) {
        const current = await prisma.order.findUnique({
            where: { id: order.id },
            select: {
                shipmentStatus: true,
                providerShipmentId: true,
                providerBatchId: true,
                shippingPaymentStatus: true,
                trackingNumber: true,
            },
        });

        return {
            ok: false,
            changed: false,
            reason: current?.providerShipmentId
                ? "Shipment sudah dibuat."
                : "Shipment sedang diproses. Silakan tunggu sebentar.",
            shipmentStatus: current?.shipmentStatus ?? null,
            shippingPaymentStatus:
                current?.shippingPaymentStatus ?? null,
            trackingNumber:
                current?.trackingNumber ?? null,
            batchId: current?.providerBatchId ?? null,
            shipmentId: current?.providerShipmentId ?? null,
        };
    }

    /*
     * ---- Pickup schedule resolution (AFTER the claim) ----
     *
     * For scheduledPickup this performs POST /time. It runs only for
     * the single claim holder, so concurrent callers can never create
     * duplicate schedules. A failure releases the claim and throws;
     * no shipment is fabricated.
     */
    let schedule: ResolvedMengantarPickup;

    try {
        schedule = await resolveMengantarPickupSchedule(pickup);
    } catch (error) {
        await releaseShipmentClaim(
            order.id,
            "CREATING",
            "NOT_CREATED"
        );

        throw error;
    }

    let result: Awaited<ReturnType<typeof createMengantarOrder>>;

    try {
        result = await createMengantarOrder({
            courier: resolvedCourier,
            pickup:
                schedule.type === "scheduledPickup"
                    ? {
                          type: "scheduledPickup",
                          volume: schedule.volume,
                          address_id: schedule.address_id,
                          time_id: schedule.time_id,
                      }
                    : {
                          type: "dropOff",
                          address_id: schedule.address_id,
                      },
            orders: [orderPayload],
        });
    } catch (error) {
        // Release the claim so the admin can retry after fixing the
        // provider-side problem (invalid data, 409, network, ...).
        await releaseShipmentClaim(
            order.id,
            "CREATING",
            "NOT_CREATED"
        );

        throw error;
    }

    const created = result.data?.[0];

    /*
     * A shipment Mengantar created ALWAYS carries a provider
     * ORDER_ID — it is returned on success and on insufficient
     * balance. `isPaid:false` / `cnote_no:null` is therefore still a
     * CREATED order, NOT a rejection. Only an item without an
     * ORDER_ID means nothing was created. Gating on anything else
     * (e.g. the documented `error: null` field, or a missing
     * `cnote_no`) misreports a real provider shipment as
     * "Gagal dibuat" and makes the next retry POST a duplicate order.
     */
    if (!created || !created.ORDER_ID) {
        await releaseShipmentClaim(
            order.id,
            "CREATING",
            "FAILED"
        );

        return {
            ok: false,
            reason:
                "Mengantar menolak pembuatan shipment. Silakan cek data pesanan.",
            batchId: result.batch_id || null,
        };
    }

    const paid =
        created.isPaid === true &&
        Boolean(created.cnote_no);

    /*
     * Non-COD with insufficient balance is still CREATED by Mengantar
     * but unpaid and WITHOUT a tracking number. It must NOT be treated
     * as shipped.
     */
    /*
     * COD scope: Mengantar bills the RECIPIENT on delivery, so a COD
     * order has NO seller-balance shipping payment step.
     * `payUnpaidShipmentForOrder` refuses COD and reconcile excludes
     * COD, which makes WAITING_SHIPPING_PAYMENT an UNRECOVERABLE state
     * for COD. A returned ORDER_ID is therefore the authoritative
     * success signal for COD and maps directly to CREATED (the
     * "menunggu penjemputan" state).
     *
     * NON-COD semantics are unchanged: insufficient balance still
     * yields WAITING_SHIPPING_PAYMENT / UNPAID.
     */
    const shipmentStatus = isCod
        ? "CREATED"
        : paid
          ? "CREATED"
          : "WAITING_SHIPPING_PAYMENT";

    const shippingPaymentStatus =
        isCod ? "NOT_APPLICABLE" : paid ? "PAID" : "UNPAID";

    const finalizeData = {
        providerShipmentId: created.ORDER_ID,
        providerBatchId:
            result.batch_id || created.batch_id || null,
        providerCourier: resolvedCourier,
        trackingNumber: created.cnote_no ?? null,
        shipmentStatus,
        shippingPaymentStatus,
    };

    // CAS persistence: only the claim holder (CREATING) may finalize,
    // so a concurrent duplicate can never overwrite a newer state.
    const finalized = await prisma.order.updateMany({
        where: {
            id: order.id,
            shipmentStatus: "CREATING",
        },
        data: finalizeData,
    });

    /*
     * Finalize-miss recovery.
     *
     * If the CAS above did not land (the 5-minute claim was reclaimed,
     * or the write raced), the provider order still EXISTS. An
     * unrecorded ORDER_ID is exactly what makes a later retry POST a
     * SECOND shipment, so the identifiers must never be dropped.
     * Backfill only while the provider id is still empty and the
     * shipment has not moved past create — this can never regress a
     * shipped parcel nor overwrite a concurrent finalize.
     */
    if (finalized.count === 0) {
        await prisma.order.updateMany({
            where: {
                id: order.id,
                providerShipmentId: null,
                shipmentStatus: {
                    in: [
                        "CREATING",
                        "FAILED",
                        "NOT_CREATED",
                        "SHIPMENT_PENDING",
                    ],
                },
            },
            data: finalizeData,
        });
    }

    return {
        ok: true,
        changed: true,
        shipmentStatus,
        shippingPaymentStatus,
        trackingNumber: created.cnote_no ?? null,
        batchId:
            result.batch_id || created.batch_id || null,
        shipmentId: created.ORDER_ID,
        pickupSchedule: schedule.schedule,
    };
}

export type DeleteShipmentActionResult = {
    ok: boolean;
    changed: boolean;
    deleted?: boolean;
    reason?: string;
    shipmentStatus?: string | null;
};

/**
 * ============================================================
 * ADMIN INTENTIONAL DELETION (🗑️ Pelacak Order)
 * ============================================================
 *
 * Server-authoritative. Clears the local shipment/tracking and marks
 * the order `shipmentStatus = "DELETED"` so reconcile/cron and the
 * worker can NEVER auto-recreate it.
 *
 * HARD RULES:
 *   - Only `MENGANTAR` orders.
 *   - NEVER touches Order.paymentStatus / status / total — the order
 *     stays PAID and is not cancelled.
 *   - Atomic CAS pinned to the EXACT state read, so a concurrent
 *     create/worker claim (which moves `shipmentStatus`) can never be
 *     clobbered; in that case it asks the admin to retry.
 *   - Any queued/claimed ShipmentJob is invalidated.
 *   - Duplicate clicks are idempotent (no second audit, no state churn).
 *   - Audited with an existing action; no credential is ever stored.
 *
 * Manual recovery is still available: the existing admin create route
 * calls `createShipmentForOrder(orderId, { allowDeleted: true })`.
 * ============================================================
 */
export async function deleteMengantarShipmentForOrder(
    orderId: number,
    adminId: string
): Promise<DeleteShipmentActionResult> {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            shippingProvider: true,
            shipmentStatus: true,
            providerShipmentId: true,
            providerBatchId: true,
            trackingNumber: true,
        },
    });

    if (!order) {
        return { ok: false, changed: false, reason: "Pesanan tidak ditemukan." };
    }

    if (order.shippingProvider !== "MENGANTAR") {
        return {
            ok: false,
            changed: false,
            reason:
                "Pesanan ini tidak menggunakan pengiriman Mengantar.",
        };
    }

    // Idempotent: already deleted with nothing left to clear.
    if (
        order.shipmentStatus === "DELETED" &&
        !order.providerShipmentId &&
        !order.providerBatchId &&
        !order.trackingNumber
    ) {
        return {
            ok: true,
            changed: false,
            deleted: true,
            shipmentStatus: "DELETED",
            reason: "Shipment sudah dihapus.",
        };
    }

    /*
     * Atomic CAS on the exact state we just read. A concurrent create
     * (CREATING) or finalize (CREATED) moves `shipmentStatus`, so the
     * WHERE no longer matches and we never null out a live shipment.
     */
    const cleared = await prisma.order.updateMany({
        where: {
            id: order.id,
            shippingProvider: "MENGANTAR",
            shipmentStatus: order.shipmentStatus,
            providerShipmentId: order.providerShipmentId,
        },
        data: {
            shipmentStatus: "DELETED",
            providerShipmentId: null,
            providerBatchId: null,
            trackingNumber: null,
        },
    });

    if (cleared.count === 0) {
        return {
            ok: false,
            changed: false,
            reason:
                "State shipment sedang berubah. Silakan coba lagi sebentar lagi.",
        };
    }

    /*
     * Invalidate the outbox so the worker cannot recreate. The worker
     * ALSO has a final `DELETED` state check before any provider call.
     */
    await prisma.shipmentJob.updateMany({
        where: {
            orderId: order.id,
            status: { in: ["PENDING", "FAILED", "PROCESSING"] },
        },
        data: {
            status: "CANCELLED",
            lockedAt: null,
            lastError: "Shipment dihapus manual oleh admin.",
        },
    });

    await createAuditLog({
        adminId,
        action: "MENGANTAR_SHIPMENT_DELETED_EXTERNALLY",
        entityType: "Order",
        entityId: order.id,
        description:
            "Admin menghapus shipment/tracking Mengantar secara manual; tidak akan dibuat ulang otomatis.",
        metadata: {
            orderId: order.id,
            source: "ADMIN_TRACKER",
            hadProviderShipmentId: Boolean(
                order.providerShipmentId
            ),
            hadTrackingNumber: Boolean(
                order.trackingNumber
            ),
            previousShipmentStatus: order.shipmentStatus,
        },
    });

    return {
        ok: true,
        changed: true,
        deleted: true,
        shipmentStatus: "DELETED",
    };
}

export async function payUnpaidShipmentForOrder(
    orderId: number
): Promise<ShipmentActionResult> {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            shippingProvider: true,
            providerCourier: true,
            providerBatchId: true,
            shipmentStatus: true,
            shippingPaymentStatus: true,
            paymentMethod: true,
        },
    });

    if (!order) {
        return { ok: false, reason: "Pesanan tidak ditemukan." };
    }

    if (order.shippingProvider !== "MENGANTAR") {
        return {
            ok: false,
            reason:
                "Pesanan ini tidak menggunakan pengiriman Mengantar.",
        };
    }

    if (order.paymentMethod === "COD") {
        return {
            ok: false,
            reason:
                "COD tidak dibayar dari saldo Mengantar.",
        };
    }

    if (order.shipmentStatus !== "WAITING_SHIPPING_PAYMENT") {
        return {
            ok: false,
            reason:
                "Shipment ini tidak dalam status menunggu pembayaran ongkir.",
        };
    }

    const courier = toMengantarCourier(
        order.providerCourier
    );

    if (!courier || !order.providerBatchId) {
        return {
            ok: false,
            reason:
                "Data batch/kurir Mengantar tidak lengkap.",
        };
    }

    /*
     * ---- Race guard: atomic DB claim ----
     *
     * /order/pay-unpaid charges the seller balance and generates the
     * cnote. Two concurrent calls would double-charge. Only one caller
     * may move WAITING_SHIPPING_PAYMENT → PAYING.
     */
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);

    const claim = await prisma.order.updateMany({
        where: {
            id: order.id,
            shippingProvider: "MENGANTAR",
            OR: [
                {
                    shipmentStatus:
                        "WAITING_SHIPPING_PAYMENT",
                },
                {
                    shipmentStatus: "PAYING",
                    updatedAt: { lt: staleBefore },
                },
            ],
        },
        data: { shipmentStatus: "PAYING" },
    });

    if (claim.count === 0) {
        const current = await prisma.order.findUnique({
            where: { id: order.id },
            select: {
                shipmentStatus: true,
                shippingPaymentStatus: true,
                trackingNumber: true,
            },
        });

        if (
            current?.shippingPaymentStatus === "PAID" ||
            current?.shipmentStatus === "CREATED"
        ) {
            return {
                ok: true,
                changed: false,
                reason: "Ongkir sudah dibayar.",
                shipmentStatus:
                    current?.shipmentStatus ?? "CREATED",
                shippingPaymentStatus: "PAID",
                trackingNumber:
                    current?.trackingNumber ?? null,
                batchId: order.providerBatchId,
            };
        }

        return {
            ok: false,
            reason:
                "Pembayaran ongkir sedang diproses. Silakan tunggu sebentar.",
            batchId: order.providerBatchId,
        };
    }

    let result: Awaited<ReturnType<typeof payMengantarUnpaid>>;

    try {
        result = await payMengantarUnpaid({
            courier,
            batchId: order.providerBatchId,
        });
    } catch (error) {
        await releaseShipmentClaim(
            order.id,
            "PAYING",
            "WAITING_SHIPPING_PAYMENT"
        );

        throw error;
    }

    const trackingNumber = result.cnoteNos[0] ?? null;

    await prisma.order.updateMany({
        where: {
            id: order.id,
            shipmentStatus: "PAYING",
        },
        data: {
            shippingPaymentStatus: "PAID",
            shipmentStatus: "CREATED",
            ...(trackingNumber
                ? { trackingNumber }
                : {}),
        },
    });

    return {
        ok: true,
        changed: true,
        shipmentStatus: "CREATED",
        shippingPaymentStatus: "PAID",
        trackingNumber,
        batchId: order.providerBatchId,
    };
}

export type { MengantarCourier };
