/**
 * READ-ONLY audit for "clear order history, keep master data".
 *
 * This script ONLY executes SELECT / SHOW statements. Every query is
 * routed through `ro()` which refuses anything that is not a read.
 * It never writes to the database, never touches .env, and never
 * prints DATABASE_URL or any credential.
 *
 * Usage:
 *   npx tsx scripts/audit-order-cleanup.ts            # full report
 *   npx tsx scripts/audit-order-cleanup.ts --json     # machine output
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: [] });

type Row = Record<string, unknown>;

const READ_ONLY = /^\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN)\b/i;

async function ro<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
  if (!READ_ONLY.test(sql)) {
    throw new Error(`Refused non-read-only statement: ${sql.slice(0, 60)}`);
  }
  // $queryRawUnsafe is safe here: callers are internal constants, and the
  // read-only guard above blocks every mutating statement.
  return (await prisma.$queryRawUnsafe(sql, ...params)) as T[];
}

function n(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

function pad(s: string, w: number) {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function padL(s: string, w: number) {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

async function main() {
  const json = process.argv.includes("--json");
  const out: Record<string, unknown> = {};

  // ---------------------------------------------------------------- 1. DB
  const meta = (
    await ro(
      `SELECT DATABASE() AS db, VERSION() AS version,
              @@global.foreign_key_checks AS fk_checks,
              @@global.sql_mode AS sql_mode`,
    )
  )[0] as Row;

  // ------------------------------------------------------- 2. table counts
  const tables = await ro<Row>(
    `SELECT TABLE_NAME AS t, TABLE_TYPE AS type, ENGINE AS engine,
            TABLE_COLLATION AS collation
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME`,
  );

  const counts: Array<{ table: string; type: string; rows: number; error?: string }> = [];
  for (const t of tables) {
    const name = String(t.t);
    try {
      const r = (await ro(`SELECT COUNT(*) AS c FROM \`${name}\``))[0] as Row;
      counts.push({ table: name, type: String(t.type), rows: n(r.c) });
    } catch (e) {
      counts.push({ table: name, type: String(t.type), rows: -1, error: (e as Error).message });
    }
  }

  // ------------------------------------------------------------- 3. FKs
  const fks = await ro<Row>(
    `SELECT kcu.TABLE_NAME        AS child_table,
            kcu.COLUMN_NAME       AS child_col,
            kcu.REFERENCED_TABLE_NAME  AS parent_table,
            kcu.REFERENCED_COLUMN_NAME AS parent_col,
            rc.DELETE_RULE        AS on_delete,
            rc.UPDATE_RULE        AS on_update,
            kcu.CONSTRAINT_NAME   AS constraint_name
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
      WHERE kcu.TABLE_SCHEMA = DATABASE()
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY kcu.TABLE_NAME, kcu.COLUMN_NAME`,
  );

  // ------------------------------------------- 4. triggers / events / procs
  const triggers = await ro<Row>(
    `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing,
            EVENT_MANIPULATION AS event
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()`,
  );

  const events = await ro<Row>(
    `SELECT EVENT_NAME AS name, STATUS AS status, EVENT_TYPE AS type,
            INTERVAL_VALUE AS every_val, INTERVAL_FIELD AS every_unit
       FROM information_schema.EVENTS
      WHERE EVENT_SCHEMA = DATABASE()`,
  );

  const routines = await ro<Row>(
    `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type
       FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = DATABASE()`,
  );

  // ------------------------------------------ 5. legacy money/transaction
  const moneyColumns = await ro<Row>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND DATA_TYPE IN ('decimal','int','bigint','float','double')
        AND (COLUMN_NAME LIKE '%commission%'
             OR COLUMN_NAME LIKE '%amount%'
             OR COLUMN_NAME LIKE '%usedCount%'
             OR COLUMN_NAME LIKE '%sold%'
             OR COLUMN_NAME LIKE '%stock%'
             OR COLUMN_NAME LIKE '%paid%')
      ORDER BY TABLE_NAME, COLUMN_NAME`,
  );

  // --------------------------------------------------- 6. timestamps / opts
  const hasCol = async (table: string, col: string) => {
    const r = await ro(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
      table,
      col,
    );
    return n((r[0] as Row).c) > 0;
  };

  const tableSet = new Set(counts.map((c) => c.table));

  // ------------------------------------------------------- 7. order states
  const orderStats: Row[] = tableSet.has("order")
    ? ((await ro(
        `SELECT status, paymentStatus, paymentMethod, COUNT(*) AS c
           FROM \`order\` GROUP BY status, paymentStatus, paymentMethod
          ORDER BY c DESC`,
      )) as Row[])
    : [];

  const orderDates: Row[] = tableSet.has("order")
    ? ((await ro(
        `SELECT MIN(createdAt) AS min_created, MAX(createdAt) AS max_created,
                SUM(userId IS NULL) AS guest_orders, COUNT(*) AS total
           FROM \`order\``,
      )) as Row[])
    : [];

  // ------------------------------------------------- 8. category C signals
  const c: Record<string, number | string> = {};
  const count = async (label: string, sql: string) => {
    try {
      const r = (await ro(sql))[0] as Row;
      c[label] = n(r.c);
    } catch (e) {
      c[label] = `ERR: ${(e as Error).message.slice(0, 80)}`;
    }
  };

  await count("orders with PAID paymentStatus", `SELECT COUNT(*) c FROM \`order\` WHERE paymentStatus='PAID'`);
  await count("orders with PENDING paymentStatus", `SELECT COUNT(*) c FROM \`order\` WHERE paymentStatus='PENDING'`);
  await count("orders status PENDING", `SELECT COUNT(*) c FROM \`order\` WHERE status='PENDING'`);
  await count("orders status PAID/PROCESSING/SHIPPED", `SELECT COUNT(*) c FROM \`order\` WHERE status IN ('PAID','PROCESSING','SHIPPED')`);
  await count("orders status REFUND_PENDING", `SELECT COUNT(*) c FROM \`order\` WHERE status='REFUND_PENDING'`);
  await count("COD orders not COMPLETED/CANCELLED", `SELECT COUNT(*) c FROM \`order\` WHERE paymentMethod='COD' AND status NOT IN ('COMPLETED','CANCELLED')`);
  await count("unpaid (UNPAID) orders", `SELECT COUNT(*) c FROM \`order\` WHERE paymentStatus='UNPAID'`);
  await count("orders with voucherId", `SELECT COUNT(*) c FROM \`order\` WHERE voucherId IS NOT NULL`);
  await count("orders with shippingDiscountId", `SELECT COUNT(*) c FROM \`order\` WHERE shippingDiscountId IS NOT NULL`);
  await count("orders with providerShipmentId", `SELECT COUNT(*) c FROM \`order\` WHERE providerShipmentId IS NOT NULL`);
  await count("orders shipmentStatus active (not DELIVERED/CANCELLED/RETURNED)", `SELECT COUNT(*) c FROM \`order\` WHERE shipmentStatus IS NOT NULL AND shipmentStatus NOT IN ('DELIVERED','CANCELLED','RETURNED','NOT_CREATED')`);
  await count("orders requiresCodReview", `SELECT COUNT(*) c FROM \`order\` WHERE requiresCodReview=1`);
  await count("orders codReviewStatus PENDING", `SELECT COUNT(*) c FROM \`order\` WHERE codReviewStatus='PENDING'`);
  await count("orders with originalSpinWheelSpinId", `SELECT COUNT(*) c FROM \`order\` WHERE originalSpinWheelSpinId IS NOT NULL`);

  // Voucher / promo counters
  await count("voucher.usedCount > 0", `SELECT COUNT(*) c FROM voucher WHERE usedCount > 0`);
  await count("voucher.usedCount total", `SELECT COALESCE(SUM(usedCount),0) c FROM voucher`);
  await count("shippingdiscount.usedCount > 0", `SELECT COUNT(*) c FROM shippingdiscount WHERE usedCount > 0`);
  await count("shippingdiscount usedCount total", `SELECT COALESCE(SUM(usedCount),0) c FROM shippingdiscount`);
  await count("flashsale.soldCount > 0", `SELECT COUNT(*) c FROM flashsale WHERE soldCount > 0`);
  await count("flashsale soldCount total", `SELECT COALESCE(SUM(soldCount),0) c FROM flashsale`);
  await count("spinwheelreward usedQuantity total", `SELECT COALESCE(SUM(usedQuantity),0) c FROM spinwheelreward`);
  await count("product.sold > 0", `SELECT COUNT(*) c FROM product WHERE sold > 0`);
  await count("product.sold total (all products)", `SELECT COALESCE(SUM(sold),0) c FROM product`);

  // Affiliate
  await count("affiliateconversion PENDING", `SELECT COUNT(*) c FROM affiliateconversion WHERE status='PENDING'`);
  await count("affiliateconversion APPROVED", `SELECT COUNT(*) c FROM affiliateconversion WHERE status='APPROVED'`);
  await count("affiliateconversion PAID", `SELECT COUNT(*) c FROM affiliateconversion WHERE status='PAID'`);
  await count("affiliateconversion total", `SELECT COUNT(*) c FROM affiliateconversion`);
  await count("affiliate conversion commission total", `SELECT COALESCE(SUM(commissionAmount),0) c FROM affiliateconversion`);
  await count("affiliatepayout PENDING/PROCESSING", `SELECT COUNT(*) c FROM affiliatepayout WHERE status IN ('PENDING','PROCESSING')`);
  await count("affiliatepayout PAID", `SELECT COUNT(*) c FROM affiliatepayout WHERE status='PAID'`);

  // Refund
  await count("refund PENDING/PROCESSING", `SELECT COUNT(*) c FROM refund WHERE status IN ('PENDING','PROCESSING')`);
  await count("refund COMPLETED", `SELECT COUNT(*) c FROM refund WHERE status='COMPLETED'`);
  await count("refund total", `SELECT COUNT(*) c FROM refund`);

  // ShipmentJob
  await count("shipmentjob PENDING/PROCESSING", `SELECT COUNT(*) c FROM shipmentjob WHERE status IN ('PENDING','PROCESSING')`);
  await count("shipmentjob FAILED", `SELECT COUNT(*) c FROM shipmentjob WHERE status='FAILED'`);
  await count("shipmentjob DONE", `SELECT COUNT(*) c FROM shipmentjob WHERE status='DONE'`);

  // Notifications referencing orders
  await count("notification rows with orderId", `SELECT COUNT(*) c FROM notification WHERE orderId IS NOT NULL`);
  await count("notification QUEUED/PROCESSING", `SELECT COUNT(*) c FROM notification WHERE status IN ('QUEUED','PROCESSING')`);

  // WhatsApp state bound to orders
  await count("whatsapp chat states with verifiedOrderId", `SELECT COUNT(*) c FROM whatsapp_chat_state WHERE verifiedOrderId IS NOT NULL`);
  await count("whatsapp chat states total", `SELECT COUNT(*) c FROM whatsapp_chat_state`);
  await count("whatsapp inbound messages total", `SELECT COUNT(*) c FROM whatsapp_inbound_message`);

  // Guest recovery
  await count("guest recovery challenges total", `SELECT COUNT(*) c FROM guestrecoverychallenge`);
  await count("guest recovery unconsumed & unexpired", `SELECT COUNT(*) c FROM guestrecoverychallenge WHERE consumedAt IS NULL AND expiresAt > NOW()`);

  // Cart / cartitem (not order-derived; guest carts)
  await count("cart total", `SELECT COUNT(*) c FROM cart`);
  await count("cart guest (userId NULL)", `SELECT COUNT(*) c FROM cart WHERE userId IS NULL`);

  // Spin wheel
  await count("spinwheelspin total", `SELECT COUNT(*) c FROM spinwheelspin`);
  await count("spinwheelspin bound to an order", `SELECT COUNT(*) c FROM spinwheelspin WHERE orderId IS NOT NULL`);
  await count("spinwheelspin USED", `SELECT COUNT(*) c FROM spinwheelspin WHERE status='USED'`);
  await count("spinwheelspin AVAILABLE", `SELECT COUNT(*) c FROM spinwheelspin WHERE status='AVAILABLE'`);

  // Flash sale purchases / voucher usage (no orderId column -> need reasoning)
  await count("flashsalepurchase total", `SELECT COUNT(*) c FROM flashsalepurchase`);
  await count("voucheruserusage total", `SELECT COUNT(*) c FROM voucheruserusage`);
  await count("voucheruserusage usageCount sum", `SELECT COALESCE(SUM(usageCount),0) c FROM voucheruserusage`);

  // Admin audit logs that reference orders
  await count("adminauditlog total", `SELECT COUNT(*) c FROM adminauditlog`);
  await count("adminauditlog entityType=order", `SELECT COUNT(*) c FROM adminauditlog WHERE entityType IN ('order','Order','ORDER')`);

  // Broadcast
  await count("broadcast total", `SELECT COUNT(*) c FROM broadcast`);

  // Orphan analysis: child rows whose parent is gone (should be 0)
  await count("orderitem orphans", `SELECT COUNT(*) c FROM orderitem oi LEFT JOIN \`order\` o ON o.id=oi.orderId WHERE o.id IS NULL`);
  await count("notification orphans", `SELECT COUNT(*) c FROM notification n LEFT JOIN \`order\` o ON o.id=n.orderId WHERE n.orderId IS NOT NULL AND o.id IS NULL`);
  await count("affiliateconversion orphans", `SELECT COUNT(*) c FROM affiliateconversion ac LEFT JOIN \`order\` o ON o.id=ac.orderId WHERE o.id IS NULL`);
  await count("shipmentjob orphans", `SELECT COUNT(*) c FROM shipmentjob sj LEFT JOIN \`order\` o ON o.id=sj.orderId WHERE o.id IS NULL`);

  if (json) {
    out.meta = meta;
    out.counts = counts;
    out.fks = fks;
    out.triggers = triggers;
    out.events = events;
    out.routines = routines;
    out.orderStats = orderStats;
    out.orderDates = orderDates;
    out.categoryC = c;
    out.moneyColumns = moneyColumns;
    console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    await prisma.$disconnect();
    return;
  }

  // ------------------------------------------------------------- reporting
  const line = (t: string) => console.log(`\n## ${t}\n`);
  console.log(`# ORDER-DATA CLEANUP AUDIT (READ-ONLY)`);
  console.log(`\n- database: ${meta.db}`);
  console.log(`- server: ${meta.version}`);
  console.log(`- foreign_key_checks (global): ${meta.fk_checks}`);
  console.log(`- sql_mode: ${meta.sql_mode}`);
  console.log(`- audited at: ${new Date().toISOString()}`);

  line("A. TABLES & EXACT ROW COUNTS");
  const w = Math.max(...counts.map((x) => x.table.length), 5) + 2;
  console.log(`${pad("table", w)}${padL("rows", 10)}  type`);
  for (const t of counts.sort((a, b) => b.rows - a.rows)) {
    console.log(`${pad(t.table, w)}${padL(t.rows < 0 ? "ERR" : String(t.rows), 10)}  ${t.type}${t.error ? "  " + t.error.slice(0, 60) : ""}`);
  }
  console.log(`\ntotal tables: ${counts.length}`);
  console.log(`total rows: ${counts.reduce((s, x) => s + Math.max(0, x.rows), 0)}`);

  line("B. FOREIGN KEYS (actual DB, not schema file)");
  for (const f of fks) {
    console.log(
      `${pad(String(f.child_table), 28)}.${pad(String(f.child_col), 26)} -> ${pad(String(f.parent_table), 26)}.${pad(String(f.parent_col), 18)} ON DELETE ${f.on_delete} / ON UPDATE ${f.on_update}`,
    );
  }
  console.log(`\ntotal FK constraints: ${fks.length}`);

  line("C. TRIGGERS / EVENTS / ROUTINES");
  console.log(`triggers: ${triggers.length}`);
  for (const t of triggers) console.log(`  - ${t.name} on ${t.tbl} ${t.timing} ${t.event}`);
  console.log(`events (DB scheduler cron): ${events.length}`);
  for (const e of events) console.log(`  - ${e.name} status=${e.status} every ${e.every_val} ${e.every_unit}`);
  console.log(`routines: ${routines.length}`);
  for (const r of routines) console.log(`  - ${r.name} (${r.type})`);

  line("D. ORDER STATE DISTRIBUTION");
  for (const r of orderStats) {
    console.log(`status=${pad(String(r.status), 15)} payment=${pad(String(r.paymentMethod), 15)} payStatus=${pad(String(r.paymentStatus), 12)} count=${r.c}`);
  }
  if (orderDates[0]) {
    const d = orderDates[0];
    console.log(`\norders total=${d.total} min=${d.min_created} max=${d.max_created} guest(userId NULL)=${d.guest_orders}`);
  }

  line("E. CATEGORY C SIGNALS (manual decision required)");
  for (const [k, v] of Object.entries(c)) console.log(`${pad(k, 58)} ${v}`);

  line("F. MONEY / COUNTER COLUMNS IN SCHEMA");
  for (const m of moneyColumns) console.log(`${pad(String(m.t), 26)} ${pad(String(m.c), 26)} ${m.ty}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("AUDIT FAILED:", e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
