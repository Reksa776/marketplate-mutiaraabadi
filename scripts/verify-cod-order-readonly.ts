/*
 * ============================================================
 * COD ORDER — READ-ONLY PRE-RECOVERY VERIFICATION
 * ============================================================
 *
 * Run:
 *   ORDER_ID=985 npx tsx scripts/verify-cod-order-readonly.ts
 *
 * WHY THIS EXISTS
 * ---------------
 * Before recovering a COD order whose shipment was stranded (the
 * order #985 shape: MENGANTAR / NOT_CREATED / requiresCodReview=true /
 * PENDING / providerShipmentId NULL / no ShipmentJob), the operator must
 * be able to PROVE — without writing anything — that:
 *
 *   1. codAmount equals the order total, and equals
 *      subtotal − discount + shippingCost (the courier collects the
 *      full order value exactly once), and
 *   2. providerShipmentId is still NULL, with no other local evidence of
 *      a shipment (batch id / resi), so no shipment was created on the
 *      Mengantar side, and
 *   3. there is no ShipmentJob row yet, so recovering it cannot produce a
 *      SECOND shipment, and
 *   4. no migration is half-applied (pending rows in
 *      _prisma_migrations) before the hotfix is deployed.
 *
 * SAFETY
 * ------
 * READ-ONLY BY CONSTRUCTION: this script contains no create / update /
 * delete / upsert / $executeRaw. It only runs findUnique, findMany and
 * $queryRaw SELECTs, and it NEVER calls a payment or Mengantar API.
 * Exit code is 0 whether or not the order exists; use the printed
 * `checks` block for the decision.
 */

import { prisma } from "../lib/prisma";

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

    console.log(
        JSON.stringify(
            {
                orderId,
                found: true,
                orderNumber: order.orderNumber,
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
                        !order.providerShipmentId &&
                        !order.providerBatchId &&
                        !order.trackingNumber,
                    shipment_job_count: jobs.length,
                    shipment_job_statuses: jobs.map(
                        (job) => job.status
                    ),
                    pending_migrations: pending,
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
