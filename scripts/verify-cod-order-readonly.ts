/*
 * ============================================================
 * COD ORDER — READ-ONLY PRE-RECOVERY VERIFICATION
 * ============================================================
 *
 * Run:
 *   ORDER_ID=985 npx tsx scripts/verify-cod-order-readonly.ts
 *
 * OPTIONAL provider check (read-only GET, off by default):
 *   ORDER_ID=985 VERIFY_PROVIDER=1 npx tsx scripts/verify-cod-order-readonly.ts
 *
 * WHY THIS EXISTS
 * ---------------
 * A COD + MENGANTAR order is now shipped AUTOMATICALLY at checkout —
 * flagged or not — so no admin approval is needed for fulfilment. An
 * order can still end up stranded (the #985 shape: MENGANTAR /
 * NOT_CREATED / requiresCodReview=true / PENDING / providerShipmentId
 * NULL / ShipmentJob []). Before recoverying such an order the operator
 * must PROVE, without writing anything, that:
 *
 *   1. codAmount equals the order total, and equals
 *      subtotal − discount + shippingCost (the courier collects the full
 *      order value exactly once), and
 *   2. there is no LOCAL evidence that Mengantar already has the parcel
 *      (providerShipmentId / providerBatchId / resi / a handoff shipment
 *      status), and
 *   3. no pickup slot is scheduled and no ShipmentJob is mid-flight, and
 *   4. no migration is half-applied (pending rows in
 *      _prisma_migrations).
 *
 * !!! providerShipmentId IS NULL IS **NOT** PROOF !!!
 * ---------------------------------------------------
 * The provider generates its own ORDER_ID, and we only learn it from the
 * POST /order RESPONSE. A request that reached Mengantar but whose local
 * write never committed therefore leaves NO local trace at all. Mengantar
 * exposes exactly two read-only lookup keys (`order_id` and `tracking_id`
 * = resi), and a stranded order has neither — so a keyed provider lookup
 * is IMPOSSIBLE in that state.
 *
 * When VERIFY_PROVIDER=1 the script still performs the read-only lookup
 * IF a provider id or resi exists locally; otherwise it reports
 * `provider_lookup: NOT_POSSIBLE_WITHOUT_A_PROVIDER_ID` and the operator
 * MUST confirm manually in the Mengantar dashboard (match the recipient
 * name + phone + destination + order date) BEFORE recovering. Recovering
 * without that check can create a DUPLICATE provider shipment.
 *
 * SAFETY
 * ------
 * READ-ONLY ON THE DATABASE BY CONSTRUCTION: no create / update / delete
 * / upsert / $executeRaw. Only findUnique, findMany and a COUNT SELECT.
 * The provider call (optional) is a GET only — it is never invoked unless
 * VERIFY_PROVIDER=1 is set explicitly.
 *
 * RECOVERY (after a clean verdict — NOT performed by this script)
 * --------------------------------------------------------------
 *   * admin UI `/admin/orders/985` → "Buat Shipment", OR
 *   * POST /api/admin/orders/985/shipment/retry with an admin session.
 * Both go through the SINGLE `createShipmentForOrder` choke point (CAS
 * claim + provider-id idempotency), so neither can create a second
 * shipment for an order that already has one. Approving the COD review
 * is NOT part of recovery.
 *
 * Exit code is 0 whether or not the order exists; use the printed
 * `checks` / `verdict` block for the decision.
 */

import { prisma } from "../lib/prisma";

/** Shipment statuses that mean Mengantar already accepted a request. */
const PROVIDER_HANDOFF_STATUSES = [
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
];

async function main() {
    const orderId = Number(process.env.ORDER_ID ?? "985");

    if (!Number.isInteger(orderId) || orderId <= 0) {
        console.error(
            `ORDER_ID tidak valid: ${process.env.ORDER_ID ?? "(kosong)"}`
        );
        process.exitCode = 2;
        return;
    }

    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            orderNumber: true,
            status: true,
            paymentStatus: true,
            paymentMethod: true,
            shippingProvider: true,
            shipmentStatus: true,
            shippingPaymentStatus: true,
            providerShipmentId: true,
            providerBatchId: true,
            trackingNumber: true,
            codAmount: true,
            subtotal: true,
            discount: true,
            shippingCost: true,
            total: true,
            requiresCodReview: true,
            codReviewStatus: true,
            createdAt: true,
        },
    });

    const jobs = await prisma.shipmentJob.findMany({
        where: { orderId },
        select: {
            id: true,
            status: true,
            stage: true,
            attempts: true,
            nextAttemptAt: true,
            pickupDate: true,
            pickupTime: true,
            lastError: true,
        },
    });

    const pendingMigrations = await prisma.$queryRaw<
        Array<{ c: bigint }>
    >`SELECT COUNT(*) AS c FROM _prisma_migrations
      WHERE finished_at IS NULL AND rolled_back_at IS NULL`;

    const pending = Number(pendingMigrations[0]?.c ?? 0);

    if (!order) {
        console.log(
            JSON.stringify(
                {
                    orderId,
                    found: false,
                    shipmentJobCount: jobs.length,
                    pendingMigrations: pending,
                    note: "Pesanan tidak ada. Tidak ada yang diubah.",
                },
                null,
                2
            )
        );
        return;
    }

    const num = (value: unknown): number | null =>
        value === null || value === undefined
            ? null
            : Number(value);

    const codAmount = num(order.codAmount);
    const total = num(order.total);
    const expectedFromFormula =
        (num(order.subtotal) ?? 0) -
        (num(order.discount) ?? 0) +
        (num(order.shippingCost) ?? 0);

    const shipmentStatus = String(order.shipmentStatus ?? "")
        .trim()
        .toUpperCase();

    const pickupScheduled = jobs.some(
        (job) => Boolean(job.pickupDate && job.pickupTime)
    );

    const jobInFlight = jobs.some(
        (job) => job.status === "PROCESSING"
    );

    const localProviderEvidence =
        Boolean(order.providerShipmentId) ||
        Boolean(order.providerBatchId) ||
        Boolean(order.trackingNumber) ||
        PROVIDER_HANDOFF_STATUSES.includes(shipmentStatus) ||
        pickupScheduled;

    /* ---- OPTIONAL, READ-ONLY provider lookup ---- */
    let providerCheck:
        | Record<string, unknown>
        | undefined;

    if (process.env.VERIFY_PROVIDER === "1") {
        const providerKey =
            order.providerShipmentId ?? order.trackingNumber;

        if (!providerKey) {
            providerCheck = {
                attempted: false,
                result:
                    "NOT_POSSIBLE_WITHOUT_A_PROVIDER_ID",
                required_manual_check:
                    "Buka dashboard Mengantar dan cocokkan nama penerima + telepon + tujuan + tanggal order. JANGAN pulihkan bila ada shipment yang cocok.",
            };
        } else {
            const {
                getMengantarOrderByOrderId,
                getMengantarOrderByTracking,
            } = await import("../lib/mengantar");

            const found = order.providerShipmentId
                ? await getMengantarOrderByOrderId(
                      order.providerShipmentId
                  )
                : await getMengantarOrderByTracking(
                      order.trackingNumber as string
                  );

            providerCheck = {
                attempted: true,
                key: order.providerShipmentId
                    ? "order_id"
                    : "tracking_id",
                found: Boolean(found),
                providerOrderId: found?.orderId ?? null,
                providerTrackingNumber:
                    found?.trackingNumber ?? null,
                providerStatus: found?.status ?? null,
                providerStatusCategory:
                    found?.statusCategory ?? null,
                providerIsDeleted: found?.isDeleted ?? null,
            };
        }
    }

    const safeToRecover =
        codAmount !== null &&
        codAmount === total &&
        codAmount === expectedFromFormula &&
        !localProviderEvidence &&
        !jobInFlight &&
        pending === 0;

    console.log(
        JSON.stringify(
            {
                orderId,
                found: true,
                orderNumber: order.orderNumber,
                createdAt: order.createdAt,
                status: order.status,
                paymentStatus: order.paymentStatus,
                paymentMethod: order.paymentMethod,
                shippingProvider: order.shippingProvider,
                shipmentStatus: order.shipmentStatus,
                shippingPaymentStatus:
                    order.shippingPaymentStatus,
                providerShipmentId: order.providerShipmentId,
                providerBatchId: order.providerBatchId,
                trackingNumber: order.trackingNumber,
                subtotal: num(order.subtotal),
                discount: num(order.discount),
                shippingCost: num(order.shippingCost),
                total,
                codAmount,
                expectedCodFromFormula: expectedFromFormula,
                requiresCodReview: order.requiresCodReview,
                codReviewStatus: order.codReviewStatus,
                shipmentJobs: jobs,
                checks: {
                    /*
                     * NULL codAmount is NOT a match — it means the order
                     * carries no item-level COD value at all.
                     */
                    cod_eq_total:
                        codAmount !== null &&
                        codAmount === total,
                    cod_eq_subtotal_minus_discount_plus_shipping:
                        codAmount !== null &&
                        codAmount === expectedFromFormula,
                    provider_shipment_id_is_null:
                        !order.providerShipmentId,
                    no_local_provider_evidence:
                        !localProviderEvidence,
                    pickup_scheduled: pickupScheduled,
                    shipment_job_count: jobs.length,
                    shipment_job_statuses: jobs.map(
                        (job) => job.status
                    ),
                    shipment_job_in_flight: jobInFlight,
                    pending_migrations: pending,
                },
                providerCheck,
                verdict: {
                    safe_to_recover_locally: safeToRecover,
                    /*
                     * `safe_to_recover_locally` only speaks about LOCAL
                     * state. It is NOT proof about Mengantar unless the
                     * provider was actually checked.
                     */
                    provider_verified: Boolean(
                        providerCheck &&
                            providerCheck.attempted &&
                            providerCheck.found === false
                    ),
                    next_step: safeToRecover
                        ? providerCheck?.attempted
                            ? "Provider mengonfirmasi tidak ada order ini. Lanjutkan recovery lewat admin: /admin/orders/" +
                              orderId +
                              " → Buat Shipment (atau POST /api/admin/orders/" +
                              orderId +
                              "/shipment/retry). Persetujuan COD review TIDAK diperlukan."
                            : "WAJIB cek dashboard Mengantar dulu (nama+telepon+tujuan+tanggal). Tanpa itu, recovery bisa membuat shipment ganda."
                        : "JANGAN pulihkan: ada bukti lokal/provider atau job in-flight. Selesaikan secara operasional.",
                },
            },
            null,
            2
        )
    );
}

main()
    .catch((error) => {
        console.error(
            "VERIFY_COD_ORDER_FAILED:",
            error instanceof Error
                ? error.message
                : error
        );
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
