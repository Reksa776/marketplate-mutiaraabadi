/**
 * ============================================================================
 * PHASE 2 — ORDER HISTORY CLEANUP
 * ============================================================================
 *
 * DEFAULT: DRY-RUN (read-only).
 *
 * Scopes:
 *   --scope=all   (default) delete the ENTIRE order history. Requires every
 *                 global safety gate to be READY. Any open refund / payout /
 *                 COD / shipment / active payment window => BLOCKED.
 *   --scope=safe  delete ONLY the orders that are provably safe. Orders with
 *                 an open refund, an unsettled commission (or a commission
 *                 tied to an open payout), an open COD, a shipment/tracking
 *                 reference, a shipment job, or an unverifiable online
 *                 payment are KEPT and reported.
 *
 * DELETE (scope-dependent):
 *   order, orderitem, refund, affiliateconversion, order-related
 *   notification, guestrecoverychallenge, shipmentjob.
 *
 * PRESERVE ALWAYS:
 *   user, affiliateprofile, affiliatepayout, product, productvariant,
 *   voucher, shippingdiscount, all counters, spinwheelspin, adminauditlog,
 *   all other master data, and every file on disk.
 *
 * HARD SAFETY RULES:
 *   - No DELETE without `--execute` AND the required gates.
 *   - No FK-check disabling, no TRUNCATE, no DROP, no schema change.
 *   - No stock/counter/payout/audit mutation. No external API calls.
 *   - One InnoDB transaction; any post-check failure rolls back.
 *   - Target must be the LOCAL dev database `toko`.
 *
 * Usage:
 *   npx tsx scripts/order-cleanup/phase-2-cleanup.ts --dry-run
 *   npx tsx scripts/order-cleanup/phase-2-cleanup.ts --scope=safe --dry-run
 *   npx tsx scripts/order-cleanup/phase-2-cleanup.ts --scope=safe --execute \
 *     --confirm=DELETE-SAFE-ORDER-RECORDS \
 *     --backup=/path/dump.sql.gz --archive=/path/archive \
 *     --fingerprint=<from dry-run>
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const prisma = new PrismaClient({ log: [] });

const CONFIRM_ALL_TOKEN = "DELETE-ALL-ORDER-HISTORY";
const CONFIRM_SAFE_TOKEN = "DELETE-SAFE-ORDER-RECORDS";
const EXTERNAL_TOKEN = "NO_ACTIVE_SHIPMENTS";
const REQUIRED_DB = "toko";
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"];

type Db = Prisma.TransactionClient | PrismaClient;
type Scope = "all" | "safe";

/*
 * A SAFE order is one where NO of the following is true:
 *   - an OPEN refund (PENDING / PROCESSING),
 *   - an UNSETTLED commission (PENDING / APPROVED) or a commission whose
 *     affiliate has an OPEN payout (PENDING / PROCESSING),
 *   - an OPEN COD,
 *   - a tracking number / provider shipment id,
 *   - a shipment job,
 *   - an online payment that is not final and cannot be proven closed
 *     (UNPAID/PENDING with a future expiry or no expiry at all).
 *
 * Expired online payments, cancelled/failed orders, settled PAID orders and
 * settled/cancelled commissions are considered safe.
 */
const SAFE_ORDER_PREDICATE = `
  NOT EXISTS (
      SELECT 1 FROM refund r
       WHERE r.orderId = o.id AND r.status IN ('PENDING','PROCESSING')
  )
  AND NOT EXISTS (
      SELECT 1 FROM affiliateconversion c
       WHERE c.orderId = o.id
         AND (
              c.status IN ('PENDING','APPROVED')
              OR EXISTS (
                  SELECT 1 FROM affiliatepayout p
                   WHERE p.affiliateId = c.affiliateId
                     AND p.status IN ('PENDING','PROCESSING')
              )
         )
  )
  AND NOT (o.paymentMethod = 'COD' AND o.status NOT IN ('CANCELLED','COMPLETED'))
  AND o.trackingNumber IS NULL
  AND o.providerShipmentId IS NULL
  AND NOT EXISTS (SELECT 1 FROM shipmentjob j WHERE j.orderId = o.id)
  AND NOT (
      o.paymentMethod <> 'COD'
      AND o.paymentStatus IN ('UNPAID','PENDING')
      AND (o.paymentExpiresAt IS NULL OR o.paymentExpiresAt > NOW())
  )
`;

const BLOCK_REASON_SQL = `
    EXISTS (
        SELECT 1 FROM refund r
         WHERE r.orderId = o.id AND r.status IN ('PENDING','PROCESSING')
    ) AS refund_open,
    EXISTS (
        SELECT 1 FROM affiliateconversion c
         WHERE c.orderId = o.id
           AND (
                c.status IN ('PENDING','APPROVED')
                OR EXISTS (
                    SELECT 1 FROM affiliatepayout p
                     WHERE p.affiliateId = c.affiliateId
                       AND p.status IN ('PENDING','PROCESSING')
                )
           )
    ) AS conversion_liability,
    (o.paymentMethod = 'COD' AND o.status NOT IN ('CANCELLED','COMPLETED')) AS cod_open,
    (o.trackingNumber IS NOT NULL) AS tracking,
    (o.providerShipmentId IS NOT NULL) AS provider_shipment,
    EXISTS (SELECT 1 FROM shipmentjob j WHERE j.orderId = o.id) AS shipment_job,
    (
        o.paymentMethod <> 'COD'
        AND o.paymentStatus IN ('UNPAID','PENDING')
        AND (o.paymentExpiresAt IS NULL OR o.paymentExpiresAt > NOW())
    ) AS payment_unverified
`;

const REASON_KEYS = [
    "refund_open",
    "conversion_liability",
    "cod_open",
    "tracking",
    "provider_shipment",
    "shipment_job",
    "payment_unverified",
] as const;

type Args = {
    scope: Scope;
    execute: boolean;
    confirm: string | null;
    backup: string | null;
    archive: string | null;
    fingerprint: string | null;
    externalVerified: string | null;
    keepOrphanNotifications: boolean;
};

function parseArgs(argv: string[]): Args {
    const get = (name: string): string | null => {
        const prefix = `--${name}=`;
        const hit = argv.find((a) => a.startsWith(prefix));
        return hit ? hit.slice(prefix.length) : null;
    };
    const rawScope = get("scope");
    if (rawScope && rawScope !== "all" && rawScope !== "safe") {
        throw new Error(`invalid --scope=${rawScope} (expected all|safe)`);
    }
    return {
        scope: (rawScope as Scope) ?? "all",
        execute: argv.includes("--execute"),
        confirm: get("confirm"),
        backup: get("backup"),
        archive: get("archive"),
        fingerprint: get("fingerprint"),
        externalVerified: get("external-verified"),
        keepOrphanNotifications: argv.includes("--keep-orphan-notifications"),
    };
}

const args = parseArgs(process.argv.slice(2));

const J = (value: unknown): string =>
    JSON.stringify(value, (_k, v) =>
        typeof v === "bigint" ? Number(v) : v
    );

type Counts = {
    orders: number;
    orderitems: number;
    refunds: number;
    conversions: number;
    notificationsOrder: number;
    notificationsOrphan: number;
    notificationsTotal: number;
    guestRecovery: number;
    shipmentJobs: number;
};

type Blockers = {
    refundsOpen: number;
    payoutsOpen: number;
    activePaymentWindows: number;
    providerShipments: number;
    openCod: number;
    shipmentJobs: number;
    trackingNumbers: number;
    whatsappTables: number;
};

type Preserved = {
    users: number;
    affiliates: number;
    payouts: number;
    payoutAmount: string;
    products: number;
    productSold: string;
    variants: number;
    stock: string;
    vouchers: number;
    voucherUsed: string;
    shippingDiscounts: number;
    shippingUsed: string;
    spins: number;
    audit: number;
    voucherUsageRows: number;
    flashPurchaseRows: number;
};

type Identity = { db: string; host: string; version: string; fkCount: number };

type BlockedOrderRow = {
    id: number;
    orderNumber: string;
    reasons: string[];
};

/* ==========================================================
 * READERS (read-only)
 * ========================================================== */

async function readCounts(client: Db = prisma): Promise<Counts> {
    const rows = await client.$queryRaw<
        Array<{
            orders: bigint;
            orderitems: bigint;
            refunds: bigint;
            conversions: bigint;
            notificationsOrder: bigint;
            notificationsOrphan: bigint;
            notificationsTotal: bigint;
            guestRecovery: bigint;
            shipmentJobs: bigint;
        }>
    >`
        SELECT
          (SELECT COUNT(*) FROM \`order\`) AS orders,
          (SELECT COUNT(*) FROM orderitem) AS orderitems,
          (SELECT COUNT(*) FROM refund) AS refunds,
          (SELECT COUNT(*) FROM affiliateconversion) AS conversions,
          (SELECT COUNT(*) FROM notification WHERE orderId IS NOT NULL) AS notificationsOrder,
          (SELECT COUNT(*) FROM notification
             WHERE orderId IS NULL
               AND notificationType = 'ORDER_STATUS_CHANGED'
               AND idempotencyKey LIKE 'notif\\_order\\_%') AS notificationsOrphan,
          (SELECT COUNT(*) FROM notification) AS notificationsTotal,
          (SELECT COUNT(*) FROM guestrecoverychallenge) AS guestRecovery,
          (SELECT COUNT(*) FROM shipmentjob) AS shipmentJobs
    `;
    const r = rows[0];
    const n = (v: bigint) => Number(v);
    return {
        orders: n(r.orders),
        orderitems: n(r.orderitems),
        refunds: n(r.refunds),
        conversions: n(r.conversions),
        notificationsOrder: n(r.notificationsOrder),
        notificationsOrphan: n(r.notificationsOrphan),
        notificationsTotal: n(r.notificationsTotal),
        guestRecovery: n(r.guestRecovery),
        shipmentJobs: n(r.shipmentJobs),
    };
}

async function readBlockers(client: Db = prisma): Promise<Blockers> {
    const rows = await client.$queryRaw<
        Array<{
            refundsOpen: bigint;
            payoutsOpen: bigint;
            activePaymentWindows: bigint;
            providerShipments: bigint;
            openCod: bigint;
            shipmentJobs: bigint;
            trackingNumbers: bigint;
            whatsappTables: bigint;
        }>
    >`
        SELECT
          (SELECT COUNT(*) FROM refund WHERE status IN ('PENDING','PROCESSING')) AS refundsOpen,
          (SELECT COUNT(*) FROM affiliatepayout WHERE status IN ('PENDING','PROCESSING')) AS payoutsOpen,
          (SELECT COUNT(*) FROM \`order\`
             WHERE paymentStatus IN ('UNPAID','PENDING')
               AND paymentExpiresAt > NOW()) AS activePaymentWindows,
          (SELECT COUNT(*) FROM \`order\` WHERE providerShipmentId IS NOT NULL) AS providerShipments,
          (SELECT COUNT(*) FROM \`order\`
             WHERE paymentMethod = 'COD'
               AND status NOT IN ('CANCELLED','COMPLETED')) AS openCod,
          (SELECT COUNT(*) FROM shipmentjob) AS shipmentJobs,
          (SELECT COUNT(*) FROM \`order\` WHERE trackingNumber IS NOT NULL) AS trackingNumbers,
          (SELECT COUNT(*) FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME IN ('whatsapp_chat_state','whatsapp_inbound_message')) AS whatsappTables
    `;
    const r = rows[0];
    const n = (v: bigint) => Number(v);
    return {
        refundsOpen: n(r.refundsOpen),
        payoutsOpen: n(r.payoutsOpen),
        activePaymentWindows: n(r.activePaymentWindows),
        providerShipments: n(r.providerShipments),
        openCod: n(r.openCod),
        shipmentJobs: n(r.shipmentJobs),
        trackingNumbers: n(r.trackingNumbers),
        whatsappTables: n(r.whatsappTables),
    };
}

async function readPreserved(client: Db = prisma): Promise<Preserved> {
    const rows = await client.$queryRaw<
        Array<{
            users: bigint;
            affiliates: bigint;
            payouts: bigint;
            payoutAmount: string;
            products: bigint;
            productSold: string;
            variants: bigint;
            stock: string;
            vouchers: bigint;
            voucherUsed: string;
            shippingDiscounts: bigint;
            shippingUsed: string;
            spins: bigint;
            audit: bigint;
            voucherUsageRows: bigint;
            flashPurchaseRows: bigint;
        }>
    >`
        SELECT
          (SELECT COUNT(*) FROM user) AS users,
          (SELECT COUNT(*) FROM affiliateprofile) AS affiliates,
          (SELECT COUNT(*) FROM affiliatepayout) AS payouts,
          (SELECT COALESCE(SUM(amount),0) FROM affiliatepayout) AS payoutAmount,
          (SELECT COUNT(*) FROM product) AS products,
          (SELECT COALESCE(SUM(sold),0) FROM product) AS productSold,
          (SELECT COUNT(*) FROM productvariant) AS variants,
          (SELECT COALESCE(SUM(stock),0) FROM productvariant) AS stock,
          (SELECT COUNT(*) FROM voucher) AS vouchers,
          (SELECT COALESCE(SUM(usedCount),0) FROM voucher) AS voucherUsed,
          (SELECT COUNT(*) FROM shippingdiscount) AS shippingDiscounts,
          (SELECT COALESCE(SUM(usedCount),0) FROM shippingdiscount) AS shippingUsed,
          (SELECT COUNT(*) FROM spinwheelspin) AS spins,
          (SELECT COUNT(*) FROM adminauditlog) AS audit,
          (SELECT COUNT(*) FROM voucheruserusage) AS voucherUsageRows,
          (SELECT COUNT(*) FROM flashsalepurchase) AS flashPurchaseRows
    `;
    const r = rows[0];
    const s = (v: unknown) => String(v ?? "0");
    const n = (v: bigint) => Number(v);
    return {
        users: n(r.users),
        affiliates: n(r.affiliates),
        payouts: n(r.payouts),
        payoutAmount: s(r.payoutAmount),
        products: n(r.products),
        productSold: s(r.productSold),
        variants: n(r.variants),
        stock: s(r.stock),
        vouchers: n(r.vouchers),
        voucherUsed: s(r.voucherUsed),
        shippingDiscounts: n(r.shippingDiscounts),
        shippingUsed: s(r.shippingUsed),
        spins: n(r.spins),
        audit: n(r.audit),
        voucherUsageRows: n(r.voucherUsageRows),
        flashPurchaseRows: n(r.flashPurchaseRows),
    };
}

async function readIdentity(client: Db = prisma): Promise<Identity> {
    const rows = await client.$queryRaw<
        Array<{ db: string; host: string; version: string; fkCount: bigint }>
    >`
        SELECT
          DATABASE() AS db,
          @@hostname AS host,
          VERSION() AS version,
          (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE()
               AND REFERENCED_TABLE_NAME IS NOT NULL) AS fkCount
    `;
    const r = rows[0];
    return {
        db: String(r.db),
        host: String(r.host),
        version: String(r.version),
        fkCount: Number(r.fkCount),
    };
}

async function tableExists(client: Db, table: string): Promise<boolean> {
    const rows = await client.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*) AS n
          FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ${table}
    `;
    return Number(rows[0].n) === 1;
}

async function readSafeOrderIds(client: Db = prisma): Promise<number[]> {
    const rows = await client.$queryRaw<Array<{ id: number }>>`
        SELECT o.id
          FROM \`order\` o
         WHERE ${Prisma.raw(SAFE_ORDER_PREDICATE)}
         ORDER BY o.id
    `;
    return rows.map((r) => Number(r.id));
}

async function readBlockedOrders(client: Db = prisma): Promise<BlockedOrderRow[]> {
    const rows = await client.$queryRaw<
        Array<Record<string, unknown> & { id: number; orderNumber: string }>
    >`
        SELECT o.id, o.orderNumber, ${Prisma.raw(BLOCK_REASON_SQL)}
          FROM \`order\` o
         WHERE NOT (${Prisma.raw(SAFE_ORDER_PREDICATE)})
         ORDER BY o.id
    `;
    return rows.map((r) => ({
        id: Number(r.id),
        orderNumber: String(r.orderNumber),
        reasons: REASON_KEYS.filter((k) => Number(r[k]) === 1),
    }));
}

/* ==========================================================
 * DERIVED HELPERS
 * ========================================================== */

function globalBlockerList(b: Blockers, trackingVerified: boolean): string[] {
    const out: string[] = [];
    if (b.refundsOpen > 0) out.push(`refund_open=${b.refundsOpen}`);
    if (b.payoutsOpen > 0) out.push(`payout_open=${b.payoutsOpen}`);
    if (b.activePaymentWindows > 0) out.push(`active_payment_window=${b.activePaymentWindows}`);
    if (b.providerShipments > 0) out.push(`provider_shipment=${b.providerShipments}`);
    if (b.openCod > 0) out.push(`open_cod=${b.openCod}`);
    if (b.shipmentJobs > 0) out.push(`shipment_job=${b.shipmentJobs}`);
    if (b.whatsappTables < 2) out.push("whatsapp_tables_missing");
    if (b.trackingNumbers > 0 && !trackingVerified) out.push(`tracking_unverified=${b.trackingNumbers}`);
    return out;
}

function reasonCounts(blocked: BlockedOrderRow[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of REASON_KEYS) out[k] = 0;
    for (const row of blocked) {
        for (const k of row.reasons) out[k] += 1;
    }
    return out;
}

function isAlreadyClean(counts: Counts, keepOrphan: boolean): boolean {
    return (
        counts.orders === 0 &&
        counts.orderitems === 0 &&
        counts.refunds === 0 &&
        counts.conversions === 0 &&
        counts.notificationsOrder === 0 &&
        counts.guestRecovery === 0 &&
        counts.shipmentJobs === 0 &&
        (keepOrphan || counts.notificationsOrphan === 0)
    );
}

function fingerprintOf(
    scope: Scope,
    identity: Identity,
    counts: Counts,
    preserved: Preserved,
    safeIds: number[]
): string {
    return createHash("sha256")
        .update(
            J({
                scope,
                identity,
                counts,
                preserved,
                safeIdsHash: createHash("sha256")
                    .update(safeIds.join(","))
                    .digest("hex"),
            })
        )
        .digest("hex");
}

function writeFileSecure(dir: string, name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
    const esc = (v: unknown) => {
        if (v === null || v === undefined) return "";
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return (
        [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n") +
        "\n"
    );
}

/* ==========================================================
 * DRY RUN
 * ========================================================== */

async function runDryRun(): Promise<void> {
    const [identity, counts, blockers, preserved] = await Promise.all([
        readIdentity(),
        readCounts(),
        readBlockers(),
        readPreserved(),
    ]);
    const trackingVerified = args.externalVerified === EXTERNAL_TOKEN;

    if (args.scope === "safe") {
        const [safeIds, blocked] = await Promise.all([
            readSafeOrderIds(),
            readBlockedOrders(),
        ]);
        const fingerprint = fingerprintOf("safe", identity, counts, preserved, safeIds);
        const status = safeIds.length === 0 ? "NOTHING_SAFE_TO_DELETE" : "READY";
        console.log(
            J({
                mode: "dry-run",
                scope: "safe",
                target: identity,
                fingerprint,
                counts,
                safeOrders: safeIds.length,
                blockedOrders: blocked.length,
                blockedReasonCounts: reasonCounts(blocked),
                status,
            })
        );
        process.exitCode = 0;
        return;
    }

    const blockersNow = globalBlockerList(blockers, trackingVerified);
    const fingerprint = fingerprintOf("all", identity, counts, preserved, []);
    if (isAlreadyClean(counts, args.keepOrphanNotifications)) {
        console.log(
            J({
                mode: "dry-run",
                scope: "all",
                target: identity,
                fingerprint,
                counts,
                blockers: blockersNow,
                status: "ALREADY_CLEAN",
            })
        );
        process.exitCode = 0;
        return;
    }
    console.log(
        J({
            mode: "dry-run",
            scope: "all",
            target: identity,
            fingerprint,
            counts,
            candidates:
                counts.orders +
                counts.orderitems +
                counts.refunds +
                counts.conversions +
                counts.notificationsOrder +
                counts.guestRecovery +
                counts.shipmentJobs,
            blockers: blockersNow,
            preserved,
            status: blockersNow.length > 0 ? "BLOCKED" : "READY",
        })
    );
    process.exitCode = blockersNow.length > 0 ? 2 : 0;
}

/* ==========================================================
 * GATES
 * ========================================================== */

function assertLocalTarget(): void {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new Error("DATABASE_URL is not set");
    const url = new URL(raw);
    if (!LOCAL_HOSTS.includes(url.hostname)) {
        throw new Error("execute refused: target is not local");
    }
    const db = url.pathname.replace(/^\//, "");
    if (db !== REQUIRED_DB) {
        throw new Error(`execute refused: target database must be "${REQUIRED_DB}"`);
    }
}

function requiredArchiveDir(): string {
    const dir = args.archive;
    if (!dir) throw new Error("--archive is required");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new Error("archive directory not found");
    }
    return dir;
}

function assertBackup(path: string): void {
    if (!existsSync(path)) throw new Error("backup not found");
    if (statSync(path).size < 1024) throw new Error("backup too small");
    const head = readFileSync(path).subarray(0, 2);
    if (!(head[0] === 0x1f && head[1] === 0x8b)) {
        throw new Error("backup is not gzip");
    }
}

async function assertCommonGates(): Promise<void> {
    assertLocalTarget();
    if (!args.backup) throw new Error("--backup is required");
    if (!args.archive) throw new Error("--archive is required");
    if (!args.fingerprint) throw new Error("--fingerprint is required");
    assertBackup(args.backup);
    if (!existsSync(args.archive) || !statSync(args.archive).isDirectory()) {
        throw new Error("archive directory not found");
    }
}

/* ==========================================================
 * EXECUTE — SCOPE=ALL (unchanged behaviour)
 * ========================================================== */

async function runExecuteAll(): Promise<void> {
    assertLocalTarget();
    if (args.confirm !== CONFIRM_ALL_TOKEN) {
        throw new Error("confirmation token missing/wrong");
    }
    const preCounts = await readCounts();
    if (isAlreadyClean(preCounts, args.keepOrphanNotifications)) {
        console.log(J({ mode: "execute", scope: "all", status: "ALREADY_CLEAN", counts: preCounts }));
        return;
    }
    await assertCommonGates();
    if (args.externalVerified !== EXTERNAL_TOKEN) {
        throw new Error("--external-verified token missing/wrong");
    }

    const [identity, blockers, preservedBefore] = await Promise.all([
        readIdentity(),
        readBlockers(),
        readPreserved(),
    ]);
    const blockersNow = globalBlockerList(blockers, true);
    if (blockersNow.length > 0) {
        throw new Error(`BLOCKED: ${blockersNow.join(", ")}`);
    }
    const fingerprint = fingerprintOf("all", identity, preCounts, preservedBefore, []);
    if (fingerprint !== args.fingerprint) {
        throw new Error("fingerprint mismatch: database changed since dry-run");
    }
    const archiveDirPath = requiredArchiveDir();
    const whatsappHasState = await tableExists(prisma, "whatsapp_chat_state");
    writeFileSecure(
        archiveDirPath,
        "preservation-before.json",
        J({ generatedAt: new Date().toISOString(), identity, counts: preCounts, preserved: preservedBefore, fingerprint })
    );

    const txResult = await prisma.$transaction(
        async (tx) => {
            const inside = await readBlockers(tx);
            const insideBlockers = globalBlockerList(inside, true);
            if (insideBlockers.length > 0) {
                throw new Error(`BLOCKED (in-transaction): ${insideBlockers.join(", ")}`);
            }
            let whatsappBindingsCleared = 0;
            if (whatsappHasState) {
                whatsappBindingsCleared = await tx.$executeRaw`
                    UPDATE whatsapp_chat_state
                       SET verifiedOrderId = NULL, verifiedAt = NULL, pendingIntent = NULL,
                           state = CASE WHEN state IN ('VERIFIED_TRACKING','VERIFIED_DELIVERED')
                                        THEN 'IDLE' ELSE state END
                     WHERE verifiedOrderId IS NOT NULL
                       AND verifiedOrderId IN (SELECT id FROM \`order\`)
                `;
            }
            await tx.guestRecoveryChallenge.deleteMany({});
            await tx.shipmentJob.deleteMany({});
            await tx.orderItem.deleteMany({});
            await tx.refund.deleteMany({});
            await tx.affiliateConversion.deleteMany({});
            if (args.keepOrphanNotifications) {
                await tx.notification.deleteMany({ where: { orderId: { not: null } } });
            } else {
                await tx.notification.deleteMany({ where: { orderId: { not: null } } });
                await tx.$executeRaw`
                    DELETE FROM notification
                     WHERE orderId IS NULL
                       AND notificationType = 'ORDER_STATUS_CHANGED'
                       AND idempotencyKey LIKE 'notif\_order\_%'
                `;
            }
            await tx.order.deleteMany({});
            const after = await readCounts(tx);
            const orphans = await readOrphans(tx);
            if (after.orders !== 0 || after.orderitems !== 0 || after.refunds !== 0 ||
                after.conversions !== 0 || after.notificationsOrder !== 0 ||
                after.guestRecovery !== 0 || after.shipmentJobs !== 0) {
                throw new Error("scoped tables not empty after delete");
            }
            if (!args.keepOrphanNotifications && after.notificationsOrphan !== 0) {
                throw new Error("orphan order notifications remain");
            }
            if (Object.values(orphans).some((v) => v > 0)) {
                throw new Error(`orphan rows detected: ${J(orphans)}`);
            }
            const preservedAfter = await readPreserved(tx);
            if (J(preservedAfter) !== J(preservedBefore)) {
                throw new Error("preserved table baseline changed");
            }
            return { whatsappBindingsCleared };
        },
        { timeout: 120_000 }
    );

    writeFileSecure(
        archiveDirPath,
        "preservation-after.json",
        J({ generatedAt: new Date().toISOString(), identity, counts: await readCounts(), preserved: await readPreserved() })
    );
    console.log(
        J({
            mode: "execute",
            scope: "all",
            status: "COMMITTED",
            deleted: preCounts,
            whatsappBindingsCleared: txResult.whatsappBindingsCleared,
            preserved: preservedBefore,
        })
    );
}

/* ==========================================================
 * EXECUTE — SCOPE=SAFE (only provably safe records)
 * ========================================================== */

async function readOrphans(client: Db = prisma): Promise<Record<string, number>> {
    const rows = await client.$queryRaw<
        Array<{
            oi: bigint; rf: bigint; ac: bigint; nf: bigint; gr: bigint; sj: bigint;
        }>
    >`
        SELECT
          (SELECT COUNT(*) FROM orderitem x LEFT JOIN \`order\` o ON o.id = x.orderId WHERE o.id IS NULL) AS oi,
          (SELECT COUNT(*) FROM refund x LEFT JOIN \`order\` o ON o.id = x.orderId WHERE o.id IS NULL) AS rf,
          (SELECT COUNT(*) FROM affiliateconversion x LEFT JOIN \`order\` o ON o.id = x.orderId WHERE o.id IS NULL) AS ac,
          (SELECT COUNT(*) FROM notification x LEFT JOIN \`order\` o ON o.id = x.orderId WHERE x.orderId IS NOT NULL AND o.id IS NULL) AS nf,
          (SELECT COUNT(*) FROM guestrecoverychallenge x LEFT JOIN \`order\` o ON o.id = x.orderId WHERE o.id IS NULL) AS gr,
          (SELECT COUNT(*) FROM shipmentjob x LEFT JOIN \`order\` o ON o.id = x.orderId WHERE o.id IS NULL) AS sj
    `;
    const r = rows[0];
    return { orderitems: Number(r.oi), refunds: Number(r.rf), conversions: Number(r.ac), notifications: Number(r.nf), guestRecovery: Number(r.gr), shipmentJobs: Number(r.sj) };
}

async function runExecuteSafe(): Promise<void> {
    assertLocalTarget();
    if (args.confirm !== CONFIRM_SAFE_TOKEN) {
        throw new Error("confirmation token missing/wrong (expected DELETE-SAFE-ORDER-RECORDS)");
    }
    const preCounts = await readCounts();
    const safeIds = await readSafeOrderIds();
    if (safeIds.length === 0) {
        console.log(J({ mode: "execute", scope: "safe", status: "NOTHING_SAFE_TO_DELETE", counts: preCounts }));
        return;
    }
    await assertCommonGates();

    const [identity, preservedBefore] = await Promise.all([
        readIdentity(),
        readPreserved(),
    ]);
    const fingerprint = fingerprintOf("safe", identity, preCounts, preservedBefore, safeIds);
    if (fingerprint !== args.fingerprint) {
        throw new Error("fingerprint mismatch: database changed since dry-run");
    }

    const archiveDirPath = requiredArchiveDir();
    const whatsappHasState = await tableExists(prisma, "whatsapp_chat_state");
    writeFileSecure(
        archiveDirPath,
        "preservation-before.json",
        J({ generatedAt: new Date().toISOString(), identity, counts: preCounts, preserved: preservedBefore, fingerprint })
    );

    const txResult = await prisma.$transaction(
        async (tx) => {
            /*
             * Re-select the safe set INSIDE the transaction. If anything
             * changed (a refund opened, a payout opened, an order shipped,
             * a payment window came back), the hash differs and the whole
             * transaction is rejected before any DELETE.
             */
            const insideIds = await readSafeOrderIds(tx);
            const insideHash = createHash("sha256").update(insideIds.join(",")).digest("hex");
            const plannedHash = createHash("sha256").update(safeIds.join(",")).digest("hex");
            if (insideIds.length !== safeIds.length || insideHash !== plannedHash) {
                throw new Error("safe order set changed inside transaction — refusing to delete");
            }
            if (insideIds.length === 0) throw new Error("safe order set became empty");

            let whatsappBindingsCleared = 0;
            if (whatsappHasState) {
                whatsappBindingsCleared = await tx.$executeRaw`
                    UPDATE whatsapp_chat_state
                       SET verifiedOrderId = NULL, verifiedAt = NULL, pendingIntent = NULL,
                           state = CASE WHEN state IN ('VERIFIED_TRACKING','VERIFIED_DELIVERED')
                                        THEN 'IDLE' ELSE state END
                     WHERE verifiedOrderId IN (${Prisma.join(insideIds)})
                `;
            }

            const deleted = {
                orderitems: (await tx.orderItem.deleteMany({ where: { orderId: { in: insideIds } } })).count,
                refunds: (await tx.refund.deleteMany({ where: { orderId: { in: insideIds } } })).count,
                conversions: (await tx.affiliateConversion.deleteMany({ where: { orderId: { in: insideIds } } })).count,
                guestRecovery: (await tx.guestRecoveryChallenge.deleteMany({ where: { orderId: { in: insideIds } } })).count,
                shipmentJobs: (await tx.shipmentJob.deleteMany({ where: { orderId: { in: insideIds } } })).count,
                notificationsOrder: (await tx.notification.deleteMany({ where: { orderId: { in: insideIds } } })).count,
            };
            let notificationsOrphan = 0;
            if (!args.keepOrphanNotifications) {
                notificationsOrphan = await tx.$executeRaw`
                    DELETE FROM notification
                     WHERE orderId IS NULL
                       AND notificationType = 'ORDER_STATUS_CHANGED'
                       AND idempotencyKey LIKE 'notif\_order\_%'
                `;
            }
            const orders = (await tx.order.deleteMany({ where: { id: { in: insideIds } } })).count;
            if (orders !== insideIds.length) {
                throw new Error(`deleted ${orders} orders but planned ${insideIds.length}`);
            }

            const after = await readCounts(tx);
            const expected = {
                orders: preCounts.orders - orders,
                orderitems: preCounts.orderitems - deleted.orderitems,
                refunds: preCounts.refunds - deleted.refunds,
                conversions: preCounts.conversions - deleted.conversions,
                notificationsTotal: preCounts.notificationsTotal - deleted.notificationsOrder - notificationsOrphan,
                guestRecovery: preCounts.guestRecovery - deleted.guestRecovery,
                shipmentJobs: preCounts.shipmentJobs - deleted.shipmentJobs,
            };
            const mismatches: Record<string, unknown> = {};
            if (after.orders !== expected.orders) mismatches.orders = { after: after.orders, expected: expected.orders };
            if (after.orderitems !== expected.orderitems) mismatches.orderitems = { after: after.orderitems, expected: expected.orderitems };
            if (after.refunds !== expected.refunds) mismatches.refunds = { after: after.refunds, expected: expected.refunds };
            if (after.conversions !== expected.conversions) mismatches.conversions = { after: after.conversions, expected: expected.conversions };
            if (after.notificationsTotal !== expected.notificationsTotal) mismatches.notificationsTotal = { after: after.notificationsTotal, expected: expected.notificationsTotal };
            if (after.guestRecovery !== expected.guestRecovery) mismatches.guestRecovery = { after: after.guestRecovery, expected: expected.guestRecovery };
            if (after.shipmentJobs !== expected.shipmentJobs) mismatches.shipmentJobs = { after: after.shipmentJobs, expected: expected.shipmentJobs };
            if (Object.keys(mismatches).length > 0) {
                throw new Error(`post-delete count mismatch: ${J(mismatches)}`);
            }

            const orphans = await readOrphans(tx);
            if (Object.values(orphans).some((v) => v > 0)) {
                throw new Error(`orphan rows detected: ${J(orphans)}`);
            }
            const preservedAfter = await readPreserved(tx);
            if (J(preservedAfter) !== J(preservedBefore)) {
                throw new Error("preserved table baseline changed");
            }

            return {
                deleted: { orders, ...deleted, notificationsOrphan },
                after,
                whatsappBindingsCleared,
                orphans,
            };
        },
        { timeout: 120_000 }
    );

    const remainingBlocked = await readBlockedOrders();
    writeFileSecure(
        archiveDirPath,
        "preservation-after.json",
        J({
            generatedAt: new Date().toISOString(),
            identity,
            counts: await readCounts(),
            preserved: await readPreserved(),
        })
    );
    writeFileSecure(
        archiveDirPath,
        "remaining-blocked-orders.csv",
        toCsv(
            remainingBlocked.map((r) => ({
                id: r.id,
                orderNumber: r.orderNumber,
                reasons: r.reasons.join("|"),
            })),
            ["id", "orderNumber", "reasons"]
        )
    );
    console.log(
        J({
            mode: "execute",
            scope: "safe",
            status: "COMMITTED",
            deleted: txResult.deleted,
            after: txResult.after,
            remainingBlockedOrders: remainingBlocked.length,
            blockedReasonCounts: reasonCounts(remainingBlocked),
            whatsappBindingsCleared: txResult.whatsappBindingsCleared,
            preserved: preservedBefore,
        })
    );
}

/* ==========================================================
 * ENTRY
 * ========================================================== */

(async () => {
    try {
        if (args.execute) {
            if (args.scope === "safe") {
                await runExecuteSafe();
            } else {
                await runExecuteAll();
            }
        } else {
            await runDryRun();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        console.error(
            J({
                mode: args.execute ? "execute" : "dry-run",
                scope: args.scope,
                status: "BLOCKED",
                error: message,
            })
        );
        process.exitCode = 2;
    } finally {
        await prisma.$disconnect();
    }
})();
