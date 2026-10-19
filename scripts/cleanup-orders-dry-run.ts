/**
 * DRY-RUN / SIMULATION for clearing order history.
 *
 * 100% READ-ONLY. It only SELECTs. It produces the numbers used in the
 * audit report and the pre-flight that the real cleanup script will run.
 *
 * Usage:
 *   npx tsx scripts/cleanup-orders-dry-run.ts
 *   npx tsx scripts/cleanup-orders-dry-run.ts --scope=closed
 *   npx tsx scripts/cleanup-orders-dry-run.ts --json
 *
 * Scope:
 *   all     → every row in `order` (the "empty history" goal)
 *   closed  → only orders with NO open financial/fulfilment obligation
 *             (COMPLETED/CANCELLED, no open refund, no live commission,
 *              no active shipment/job, no COD still owed)
 *
 * It NEVER prints DATABASE_URL or any credential.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: [] });

const READ_ONLY = /^\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN)\b/i;

type Row = Record<string, unknown>;

async function ro<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
    if (!READ_ONLY.test(sql)) {
        throw new Error(`Refused non-read-only statement: ${sql.slice(0, 60)}`);
    }
    return (await prisma.$queryRawUnsafe(sql, ...params)) as T[];
}

const asNum = (v: unknown): number =>
    typeof v === "bigint" ? Number(v) : Number(v ?? 0);

const J = (o: unknown) =>
    JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

const args = process.argv.slice(2);
const SCOPE = (args.find((a) => a.startsWith("--scope="))?.split("=")[1] ??
    "all") as "all" | "closed";
const AS_JSON = args.includes("--json");

/** Every table that can contain order-derived rows, child → parent order. */
const CHILD_TABLES = [
    "orderitem",
    "shipmentjob",
    "guestrecoverychallenge",
    "refund",
    "affiliateconversion",
    "notification",
    "spinwheelspin",
    "whatsapp_chat_state", // no FK; exists only where the migration ran
] as const;

async function tableExists(t: string): Promise<boolean> {
    const r = await ro(
        `SELECT COUNT(*) c FROM information_schema.TABLES
          WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`,
        t,
    );
    return asNum((r[0] as Row).c) > 0;
}

async function main() {
    const existing = new Set<string>();
    for (const t of CHILD_TABLES) if (await tableExists(t)) existing.add(t);

    /* -------------------------------------------------- target order set */
    const openRefundSql = `
        NOT EXISTS (SELECT 1 FROM refund r
                     WHERE r.orderId = o.id
                       AND r.status IN ('PENDING','PROCESSING'))`;
    const liveCommissionSql = `
        NOT EXISTS (SELECT 1 FROM affiliateconversion ac
                     WHERE ac.orderId = o.id
                       AND ac.status IN ('PENDING','APPROVED','PAID'))`;
    const noActiveJobSql = `
        NOT EXISTS (SELECT 1 FROM shipmentjob sj
                     WHERE sj.orderId = o.id
                       AND sj.status IN ('PENDING','PROCESSING'))`;

    const ownerFilter =
        SCOPE === "closed"
            ? `o.status IN ('COMPLETED','CANCELLED')
               AND ${openRefundSql}
               AND ${liveCommissionSql}
               AND ${noActiveJobSql}`
            : "1=1";

    const scopeRows = await ro(
        `SELECT COUNT(*) c FROM \`order\` o WHERE ${ownerFilter}`,
    );
    const targetCount = asNum((scopeRows[0] as Row).c);

    const targetIds = (
        await ro(`SELECT o.id FROM \`order\` o WHERE ${ownerFilter} ORDER BY o.id`)
    ).map((r) => asNum((r as Row).id));

    const idList = targetIds.length ? targetIds.join(",") : "NULL";
    const totalOrdersRow = (await ro(`SELECT COUNT(*) c FROM \`order\``))[0] as Row;

    /* --------------------------------------------- blocked orders (kept) */
    const blocked = await ro(
        `SELECT o.id, o.orderNumber, o.status, o.paymentStatus,
                (SELECT COUNT(*) FROM refund r
                  WHERE r.orderId=o.id AND r.status IN ('PENDING','PROCESSING')) openRefunds,
                (SELECT COUNT(*) FROM affiliateconversion ac
                  WHERE ac.orderId=o.id AND ac.status IN ('PENDING','APPROVED','PAID')) liveCommissions,
                (SELECT COUNT(*) FROM shipmentjob sj
                  WHERE sj.orderId=o.id AND sj.status IN ('PENDING','PROCESSING')) activeJobs,
                o.shipmentStatus, o.paymentMethod
           FROM \`order\` o
          WHERE o.id NOT IN (${idList})
          ORDER BY o.id`,
    );

    /* ----------------------------------------------- per-child row counts */
    const childCounts: Record<string, number> = {};
    if (existing.has("orderitem")) {
        childCounts.orderitem = asNum(
            (await ro(`SELECT COUNT(*) c FROM orderitem WHERE orderId IN (${idList})`))[0].c,
        );
    }
    if (existing.has("shipmentjob")) {
        childCounts.shipmentjob = asNum(
            (await ro(`SELECT COUNT(*) c FROM shipmentjob WHERE orderId IN (${idList})`))[0].c,
        );
    }
    if (existing.has("guestrecoverychallenge")) {
        childCounts.guestrecoverychallenge = asNum(
            (
                await ro(
                    `SELECT COUNT(*) c FROM guestrecoverychallenge WHERE orderId IN (${idList})`,
                )
            )[0].c,
        );
    }
    if (existing.has("refund")) {
        childCounts.refund = asNum(
            (await ro(`SELECT COUNT(*) c FROM refund WHERE orderId IN (${idList})`))[0].c,
        );
        childCounts.refund_open = asNum(
            (
                await ro(
                    `SELECT COUNT(*) c FROM refund WHERE orderId IN (${idList})
                      AND status IN ('PENDING','PROCESSING')`,
                )
            )[0].c,
        );
    }
    if (existing.has("affiliateconversion")) {
        childCounts.affiliateconversion = asNum(
            (
                await ro(
                    `SELECT COUNT(*) c FROM affiliateconversion WHERE orderId IN (${idList})`,
                )
            )[0].c,
        );
        childCounts.affiliateconversion_live = asNum(
            (
                await ro(
                    `SELECT COUNT(*) c FROM affiliateconversion WHERE orderId IN (${idList})
                      AND status IN ('PENDING','APPROVED','PAID')`,
                )
            )[0].c,
        );
    }
    if (existing.has("notification")) {
        childCounts.notification_linked = asNum(
            (await ro(`SELECT COUNT(*) c FROM notification WHERE orderId IN (${idList})`))[0].c,
        );
    }
    if (existing.has("spinwheelspin")) {
        childCounts.spinwheelspin_linked = asNum(
            (await ro(`SELECT COUNT(*) c FROM spinwheelspin WHERE orderId IN (${idList})`))[0].c,
        );
        childCounts.spinwheelspin_original = asNum(
            (
                await ro(
                    `SELECT COUNT(*) c FROM \`order\` WHERE id IN (${idList})
                      AND originalSpinWheelSpinId IS NOT NULL`,
                )
            )[0].c,
        );
    }

    /* ------------------------------------------------ master data snapshot */
    const masterSnapshot: Record<string, number> = {};
    for (const t of [
        "user",
        "affiliateprofile",
        "affiliatekyc",
        "affiliateclick",
        "affiliatepayout",
        "product",
        "productvariant",
        "voucher",
        "shippingdiscount",
        "flashsale",
        "flashsalepurchase",
        "campaign",
        "productdiscount",
        "bulkdiscount",
        "promotion",
        "spinwheelcampaign",
        "spinwheelreward",
        "spinwheelspin",
        "storesetting",
        "province",
        "regency",
        "district",
        "village",
        "rajaongkirregion",
        "cart",
        "cartitem",
        "useraddress",
        "adminauditlog",
        "broadcast",
        "voucheruserusage",
        "guestrecoverychallenge",
        "notification",
        "refund",
        "affiliateconversion",
        "shipmentjob",
    ]) {
        if (!(await tableExists(t))) continue;
        masterSnapshot[t] = asNum((await ro(`SELECT COUNT(*) c FROM \`${t}\``))[0].c);
    }

    /* -------------------------------------------------- counter/state risks */
    const counterRisks = {
        voucherUsedCountNonZero: asNum(
            (await ro(`SELECT COUNT(*) c FROM voucher WHERE usedCount > 0`))[0].c,
        ),
        voucherUsedCountSum: asNum(
            (await ro(`SELECT COALESCE(SUM(usedCount),0) c FROM voucher`))[0].c,
        ),
        shippingDiscountUsedCountNonZero: asNum(
            (await ro(`SELECT COUNT(*) c FROM shippingdiscount WHERE usedCount > 0`))[0].c,
        ),
        shippingDiscountUsedCountSum: asNum(
            (await ro(`SELECT COALESCE(SUM(usedCount),0) c FROM shippingdiscount`))[0].c,
        ),
        productSoldNonZero: asNum(
            (await ro(`SELECT COUNT(*) c FROM product WHERE sold > 0`))[0].c,
        ),
        productSoldSum: asNum(
            (await ro(`SELECT COALESCE(SUM(sold),0) c FROM product`))[0].c,
        ),
        spinRewardUsedQuantitySum: asNum(
            (await ro(`SELECT COALESCE(SUM(usedQuantity),0) c FROM spinwheelreward`))[0].c,
        ),
        voucherUserUsageRows: asNum(
            (await ro(`SELECT COUNT(*) c FROM voucheruserusage`))[0].c,
        ),
        flashSalePurchaseRows: asNum(
            (await ro(`SELECT COUNT(*) c FROM flashsalepurchase`))[0].c,
        ),
        adminAuditLogOrderEntries: asNum(
            (
                await ro(
                    `SELECT COUNT(*) c FROM adminauditlog WHERE entityType='Order'`,
                )
            )[0].c,
        ),
        openAffiliatePayouts: asNum(
            (
                await ro(
                    `SELECT COUNT(*) c FROM affiliatepayout
                      WHERE status IN ('PENDING','PROCESSING')`,
                )
            )[0].c,
        ),
        ordersPaidNotCompleted: asNum(
            (
                await ro(
                    `SELECT COUNT(*) c FROM \`order\`
                      WHERE paymentStatus='PAID'
                        AND status NOT IN ('COMPLETED','REFUND_PENDING')`,
                )
            )[0].c,
        ),
        codUnsettled: asNum(
            (
                await ro(
                    `SELECT COUNT(*) c FROM \`order\`
                      WHERE paymentMethod='COD'
                        AND status NOT IN ('COMPLETED','CANCELLED')`,
                )
            )[0].c,
        ),
        ordersWithProviderShipment: asNum(
            (
                await ro(
                    `SELECT COUNT(*) c FROM \`order\` WHERE providerShipmentId IS NOT NULL`,
                )
            )[0].c,
        ),
        activeShipmentStatuses: asNum(
            (
                await ro(
                    `SELECT COUNT(*) c FROM \`order\`
                      WHERE shipmentStatus IS NOT NULL
                        AND shipmentStatus NOT IN
                            ('DELIVERED','CANCELLED','RETURNED','NOT_CREATED')`,
                )
            )[0].c,
        ),
    };

    const blockers: string[] = [];
    if (childCounts.refund_open) blockers.push(`${childCounts.refund_open} order(s) punya refund PENDING/PROCESSING`);
    if (childCounts.affiliateconversion_live) blockers.push(`${childCounts.affiliateconversion_live} komisi affiliate PENDING/APPROVED/PAID terkait order target`);
    if (counterRisks.activeShipmentStatuses) blockers.push(`${counterRisks.activeShipmentStatuses} order punya shipmentStatus aktif`);
    if (counterRisks.ordersWithProviderShipment) blockers.push(`${counterRisks.ordersWithProviderShipment} order punya providerShipmentId`);
    if (counterRisks.openAffiliatePayouts) blockers.push(`${counterRisks.openAffiliatePayouts} affiliate payout PENDING/PROCESSING`);

    /* ------------------------------------------------------------- output */
    if (AS_JSON) {
        console.log(
            J({
                scope: SCOPE,
                totalOrders: asNum(totalOrdersRow.c),
                targetOrders: targetCount,
                targetIds,
                blocked,
                childCounts,
                masterSnapshot,
                counterRisks,
            }),
        );
        await prisma.$disconnect();
        return;
    }

    console.log("=".repeat(78));
    console.log("DRY-RUN — ORDER HISTORY CLEANUP (READ-ONLY, NOTHING DELETED)");
    console.log("=".repeat(78));
    console.log(`scope            : ${SCOPE}`);
    console.log(`total orders     : ${asNum(totalOrdersRow.c)}`);
    console.log(`target orders    : ${targetCount}`);
    console.log(`left behind      : ${asNum(totalOrdersRow.c) - targetCount}`);

    console.log("\n-- child rows inside target set --");
    for (const [k, v] of Object.entries(childCounts)) console.log(`  ${k.padEnd(32)} ${v}`);

    console.log("\n-- orders NOT in target set (must be resolved manually) --");
    if (!blocked.length) console.log("  (none)");
    for (const b of blocked as Row[]) {
        console.log(
            `  order #${b.id} ${b.orderNumber} status=${b.status} pay=${b.paymentStatus}` +
                ` method=${b.paymentMethod} shipment=${b.shipmentStatus ?? "-"}` +
                ` openRefunds=${b.openRefunds} liveCommissions=${b.liveCommissions}` +
                ` activeJobs=${b.activeJobs}`,
        );
    }

    console.log("\n-- master data snapshot (must be identical after cleanup) --");
    for (const [k, v] of Object.entries(masterSnapshot)) console.log(`  ${k.padEnd(28)} ${v}`);

    console.log("\n-- counter / state risks (NOT changed by this tool) --");
    for (const [k, v] of Object.entries(counterRisks)) console.log(`  ${k.padEnd(34)} ${v}`);

    console.log("\n-- blockers --");
    if (!blockers.length) console.log("  (none detected for this scope)");
    for (const b of blockers) console.log(`  ! ${b}`);

    console.log(
        "\nVERDICT: " +
            (blockers.length
                ? "NO-GO for an unattended run — resolve the blockers first."
                : "GO for a supervised run, after a verified backup."),
    );
    console.log("\nNothing was written to the database.");

    await prisma.$disconnect();
}

main().catch(async (e) => {
    console.error("DRY-RUN FAILED:", e?.message ?? e);
    await prisma.$disconnect();
    process.exit(1);
});
