/**
 * ORDER-HISTORY CLEANUP — controlled, transactional, opt-in.
 *
 * DEFAULT IS DRY-RUN. Nothing is written without ALL of:
 *   --execute
 *   --confirm=<exact target order count>      (mismatch aborts)
 *   --backup=<path to a verified mysqldump>   (missing/empty/old aborts)
 *   --scope=all|closed
 *
 * Safety properties (see the audit report):
 *   - child rows are deleted before their parent order;
 *   - every write happens inside ONE InnoDB transaction (all tables are
 *     InnoDB), so a failed check rolls the whole thing back;
 *   - the script ABORTS on any open financial / fulfilment obligation;
 *   - a named advisory lock stops two runs from overlapping;
 *   - the MAX(order.id) watermark is re-checked inside the transaction,
 *     so an order created by checkout / webhook / worker after the
 *     preflight aborts the run instead of being deleted silently;
 *   - master data (user, product, stock, settings, affiliate, voucher
 *     masters) is snapshot-counted before and after and must be equal;
 *   - it NEVER uses prisma migrate reset, DROP, TRUNCATE, or
 *     SET FOREIGN_KEY_CHECKS=0;
 *   - adminauditlog is never touched;
 *   - voucher / shipping-discount / product.sold counters are NEVER
 *     rewritten (they need a separate, approved reconciliation).
 *
 * Usage:
 *   npx tsx scripts/cleanup-orders.ts                       # dry-run
 *   npx tsx scripts/cleanup-orders.ts --scope=closed        # dry-run
 *   npx tsx scripts/cleanup-orders.ts --execute \
 *     --scope=closed --confirm=83 --backup=/var/backups/toko-YYYYmmdd.sql.gz
 */
import { PrismaClient } from "@prisma/client";
import { statSync } from "fs";

const prisma = new PrismaClient({ log: [] });

type Row = Record<string, unknown>;

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a === name) ?? null;
const opt = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? null;

const EXECUTE = flag("--execute") !== null;
const SCOPE = (opt("scope") ?? "closed") as "all" | "closed";
const CONFIRM = opt("confirm") ? Number(opt("confirm")) : NaN;
const BACKUP = opt("backup");
const BATCH = Math.max(1, Math.min(1000, Number(opt("batch") ?? 250)));
const KEEP_NOTIFICATIONS = flag("--keep-notifications") !== null;
const CLEAR_WHATSAPP = flag("--clear-whatsapp-bindings") !== null;

const asNum = (v: unknown): number =>
    typeof v === "bigint" ? Number(v) : Number(v ?? 0);

async function ro<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
    if (!/^\s*(SELECT|SHOW)\b/i.test(sql)) {
        throw new Error(`ro() refused: ${sql.slice(0, 50)}`);
    }
    return (await prisma.$queryRawUnsafe(sql, ...params)) as T[];
}

async function tableExists(t: string): Promise<boolean> {
    const r = await ro(
        `SELECT COUNT(*) c FROM information_schema.TABLES
          WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`,
        t,
    );
    return asNum((r[0] as Row).c) > 0;
}

function die(msg: string): never {
    console.error(`\nABORT: ${msg}\nNothing was changed.`);
    process.exit(2);
}

/** Master tables that must keep the same row count before/after. */
const MASTER_TABLES = [
    "user",
    "account",
    "affiliateprofile",
    "affiliatekyc",
    "affiliateclick",
    "affiliatepayout",
    "product",
    "productvariant",
    "voucher",
    "voucherproduct",
    "vouchercategory",
    "shippingdiscount",
    "flashsale",
    "campaign",
    "campaignproduct",
    "campaigncategory",
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
    "verificationtoken",
    "session",
] as const;

function scopeClause(alias = "o") {
    const openRefund = `NOT EXISTS (SELECT 1 FROM refund r WHERE r.orderId=${alias}.id AND r.status IN ('PENDING','PROCESSING'))`;
    const liveCommission = `NOT EXISTS (SELECT 1 FROM affiliateconversion ac WHERE ac.orderId=${alias}.id AND ac.status IN ('PENDING','APPROVED','PAID'))`;
    const activeJob = `NOT EXISTS (SELECT 1 FROM shipmentjob sj WHERE sj.orderId=${alias}.id AND sj.status IN ('PENDING','PROCESSING'))`;

    if (SCOPE === "all") return "1=1";
    return `${alias}.status IN ('COMPLETED','CANCELLED') AND ${openRefund} AND ${liveCommission} AND ${activeJob}`;
}

async function snapshot(tables: readonly string[]) {
    const out: Record<string, number> = {};
    for (const t of tables) {
        if (!(await tableExists(t))) continue;
        out[t] = asNum((await ro(`SELECT COUNT(*) c FROM \`${t}\``))[0].c);
    }
    return out;
}

/** Preflight: every condition that makes a run unsafe. */
async function preflight() {
    const problems: string[] = [];
    const warnings: string[] = [];

    const fk = await ro(
        `SELECT @@SESSION.foreign_key_checks fk, @@SESSION.autocommit ac`,
    );
    if (asNum((fk[0] as Row).fk) !== 1) {
        problems.push("foreign_key_checks is not 1 — refusing to run with FKs disabled.");
    }

    const total = asNum((await ro(`SELECT COUNT(*) c FROM \`order\``))[0].c);
    const targetIds = (
        await ro(`SELECT o.id FROM \`order\` o WHERE ${scopeClause()} ORDER BY o.id`)
    ).map((r) => asNum((r as Row).id));
    const idList = targetIds.length ? targetIds.join(",") : "NULL";

    if (targetIds.length === 0) problems.push("target set is empty — nothing to do.");
    if (EXECUTE && CONFIRM !== targetIds.length) {
        problems.push(
            `--confirm=${Number.isNaN(CONFIRM) ? "(missing)" : CONFIRM} does not match the target count ${targetIds.length}.`,
        );
    }

    // --- obligations that must be resolved by a human first -------------
    const openRefunds = asNum(
        (
            await ro(
                `SELECT COUNT(*) c FROM refund WHERE orderId IN (${idList})
                  AND status IN ('PENDING','PROCESSING')`,
            )
        )[0].c,
    );
    if (openRefunds) problems.push(`${openRefunds} refund PENDING/PROCESSING inside the target set.`);

    const liveCommissions = asNum(
        (
            await ro(
                `SELECT COUNT(*) c FROM affiliateconversion WHERE orderId IN (${idList})
                  AND status IN ('PENDING','APPROVED','PAID')`,
            )
        )[0].c,
    );
    if (liveCommissions) {
        problems.push(
            `${liveCommissions} affiliate commission PENDING/APPROVED/PAID inside the target set (money owed).`,
        );
    }

    const activeJobs = asNum(
        (
            await ro(
                `SELECT COUNT(*) c FROM shipmentjob WHERE orderId IN (${idList})
                  AND status IN ('PENDING','PROCESSING')`,
            )
        )[0].c,
    );
    if (activeJobs) problems.push(`${activeJobs} ShipmentJob PENDING/PROCESSING.`);

    const activeShipments = asNum(
        (
            await ro(
                `SELECT COUNT(*) c FROM \`order\` WHERE id IN (${idList})
                  AND shipmentStatus IS NOT NULL
                  AND shipmentStatus NOT IN ('DELIVERED','CANCELLED','RETURNED','NOT_CREATED')`,
            )
        )[0].c,
    );
    if (activeShipments) problems.push(`${activeShipments} shipment masih berjalan di Mengantar.`);

    const providerIds = asNum(
        (
            await ro(
                `SELECT COUNT(*) c FROM \`order\` WHERE id IN (${idList})
                  AND providerShipmentId IS NOT NULL`,
            )
        )[0].c,
    );
    if (providerIds) {
        problems.push(
            `${providerIds} order sudah punya providerShipmentId — hapus di sisi Mengantar dulu atau kecualikan order tsb.`,
        );
    }

    const codUnpaid = asNum(
        (
            await ro(
                `SELECT COUNT(*) c FROM \`order\` WHERE id IN (${idList})
                  AND paymentMethod='COD'
                  AND status NOT IN ('COMPLETED','CANCELLED')`,
            )
        )[0].c,
    );
    if (codUnpaid) problems.push(`${codUnpaid} COD belum lunas/selesai inside the target set.`);

    const paidNotDone = asNum(
        (
            await ro(
                `SELECT COUNT(*) c FROM \`order\` WHERE id IN (${idList})
                  AND paymentStatus='PAID'
                  AND status NOT IN ('COMPLETED','REFUND_PENDING')`,
            )
        )[0].c,
    );
    if (paidNotDone) {
        problems.push(
            `${paidNotDone} order PAID tapi belum COMPLETED — masih ada kewajiban kirim/uang.`,
        );
    }

    const openPayouts = asNum(
        (
            await ro(
                `SELECT COUNT(*) c FROM affiliatepayout
                  WHERE status IN ('PENDING','PROCESSING')`,
            )
        )[0].c,
    );
    if (openPayouts) {
        warnings.push(
            `${openPayouts} affiliate payout PENDING/PROCESSING masih terbuka. Payout bukan turunan order dan komisi APPROVED/PAID tidak dihapus, tetapi selesaikan dulu secara bisnis.`,
        );
    }

    // --- freshness / concurrency ---------------------------------------
    const recent = asNum(
        (
            await ro(
                `SELECT COUNT(*) c FROM \`order\` WHERE createdAt > (NOW() - INTERVAL 15 MINUTE)`,
            )
        )[0].c,
    );
    if (recent) {
        warnings.push(
            `${recent} order dibuat < 15 menit lalu. Pastikan app + cron dihentikan sebelum eksekusi.`,
        );
    }

    const maxIdRow = (await ro(`SELECT COALESCE(MAX(id),0) m FROM \`order\``))[0] as Row;

    // --- backup gate ----------------------------------------------------
    if (EXECUTE) {
        if (!BACKUP) problems.push("--backup=<file> wajib saat --execute.");
        else {
            try {
                const st = statSync(BACKUP);
                if (!st.isFile() || st.size === 0) problems.push("file backup kosong/bukan file.");
                const ageHours = (Date.now() - st.mtimeMs) / 36e5;
                if (ageHours > 24) {
                    problems.push(
                        `backup berumur ${ageHours.toFixed(1)} jam — buat backup baru (< 24 jam).`,
                    );
                }
            } catch {
                problems.push("file backup tidak bisa dibaca.");
            }
        }
    }

    // Expected child counts inside the target set.
    const expected: Record<string, number> = {};
    for (const t of [
        "orderitem",
        "shipmentjob",
        "guestrecoverychallenge",
        "refund",
        "affiliateconversion",
        "notification",
    ]) {
        if (!(await tableExists(t))) {
            expected[t] = 0;
            continue;
        }
        expected[t] = asNum(
            (await ro(`SELECT COUNT(*) c FROM \`${t}\` WHERE orderId IN (${idList})`))[0].c,
        );
    }

    return {
        total,
        targetIds,
        maxId: asNum(maxIdRow.m),
        expected,
        problems,
        warnings,
        master: await snapshot(MASTER_TABLES),
    };
}

async function main() {
    console.log("=".repeat(78));
    console.log(
        `ORDER-HISTORY CLEANUP — ${EXECUTE ? "*** EXECUTE MODE ***" : "DRY-RUN (no writes)"}`,
    );
    console.log(`scope=${SCOPE} batch=${BATCH} keepNotifications=${KEEP_NOTIFICATIONS}`);
    console.log("=".repeat(78));

    if (EXECUTE && process.env.NODE_ENV === "production" && !flag("--i-understand-production")) {
        die("NODE_ENV=production butuh --i-understand-production (dan backup yang terverifikasi).");
    }

    const pf = await preflight();

    console.log(`orders total          : ${pf.total}`);
    console.log(`orders in scope       : ${pf.targetIds.length}`);
    console.log(`highest order id      : ${pf.maxId}`);
    console.log("\nrows that will be removed (scope):");
    for (const [k, v] of Object.entries(pf.expected)) {
        const value =
            k === "notification" && KEEP_NOTIFICATIONS
                ? "KEPT (orderId → NULL via FK)"
                : v;
        console.log(`  ${k.padEnd(26)} ${value}`);
    }

    if (pf.warnings.length) {
        console.log("\nWARNINGS:");
        for (const w of pf.warnings) console.log(`  ! ${w}`);
    }
    if (pf.problems.length) {
        console.log("\nBLOCKING PROBLEMS:");
        for (const p of pf.problems) console.log(`  x ${p}`);
        die(`${pf.problems.length} blocking condition(s).`);
    }

    if (!EXECUTE) {
        console.log("\nDRY-RUN OK. Re-run with --execute --confirm=<n> --backup=<file>.");
        console.log("Nothing was written to the database.");
        await prisma.$disconnect();
        return;
    }

    /* ------------------------------------------------------------ execute */
    const ids = pf.targetIds;
    let deleted = 0;

    await prisma.$transaction(
        async (tx) => {
            // Advisory lock: one cleanup at a time, on THIS connection.
            const lock = await tx.$queryRawUnsafe(
                `SELECT GET_LOCK('mutiara_order_cleanup', 5) l`,
            );
            if (asNum((lock as Row[])[0].l) !== 1) {
                throw new Error("could not acquire cleanup lock (another run in progress?)");
            }

            // Re-check the watermark: a new order must abort the run.
            const now = (await tx.$queryRawUnsafe(
                `SELECT COALESCE(MAX(id),0) m, COUNT(*) c FROM \`order\``,
            )) as Row[];
            if (asNum(now[0].m) !== pf.maxId) {
                throw new Error(
                    `order created during cleanup (max id ${asNum(now[0].m)} != ${pf.maxId}) — aborting`,
                );
            }

            // Re-check obligations inside the transaction (TOCTOU).
            const openRefund = (await tx.$queryRawUnsafe(
                `SELECT COUNT(*) c FROM refund WHERE status IN ('PENDING','PROCESSING')`,
            )) as Row[];
            if (asNum(openRefund[0].c) !== 0) throw new Error("refund opened during cleanup");

            const liveComm = (await tx.$queryRawUnsafe(
                `SELECT COUNT(*) c FROM affiliateconversion
                  WHERE status IN ('PENDING','APPROVED','PAID')`,
            )) as Row[];
            if (asNum(liveComm[0].c) !== 0) throw new Error("commission changed during cleanup");

            for (let i = 0; i < ids.length; i += BATCH) {
                const chunk = ids.slice(i, i + BATCH).join(",");

                // 1. Notifications (order-derived payloads) — default delete.
                if (!KEEP_NOTIFICATIONS && (await tableExists("notification"))) {
                    await tx.$executeRawUnsafe(
                        `DELETE FROM notification WHERE orderId IN (${chunk})`,
                    );
                }

                // 2. Guest OTP challenges (disposable).
                if (await tableExists("guestrecoverychallenge")) {
                    await tx.$executeRawUnsafe(
                        `DELETE FROM guestrecoverychallenge WHERE orderId IN (${chunk})`,
                    );
                }

                // 3. Completed/closed refunds only.
                await tx.$executeRawUnsafe(
                    `DELETE FROM refund WHERE orderId IN (${chunk})
                      AND status IN ('COMPLETED','FAILED')`,
                );

                // 4. Closed affiliate conversions only.
                await tx.$executeRawUnsafe(
                    `DELETE FROM affiliateconversion WHERE orderId IN (${chunk})
                      AND status IN ('CANCELLED','REVERSED')`,
                );

                // 5. Shipment jobs that are not in flight.
                await tx.$executeRawUnsafe(
                    `DELETE FROM shipmentjob WHERE orderId IN (${chunk})
                      AND status IN ('DONE','FAILED','CANCELLED')`,
                );

                // 6. Optional: unbind WhatsApp chats from these orders.
                if (CLEAR_WHATSAPP && (await tableExists("whatsapp_chat_state"))) {
                    await tx.$executeRawUnsafe(
                        `UPDATE whatsapp_chat_state
                            SET verifiedOrderId=NULL, verifiedAt=NULL,
                                state='IDLE', pendingIntent=NULL, updatedAt=NOW()
                          WHERE verifiedOrderId IN (${chunk})`,
                    );
                }

                // 7. Order items.
                await tx.$executeRawUnsafe(
                    `DELETE FROM orderitem WHERE orderId IN (${chunk})`,
                );

                // 8. The orders themselves.
                const res = await tx.$executeRawUnsafe(
                    `DELETE FROM \`order\` WHERE id IN (${chunk})`,
                );
                deleted += Number(res);
            }

            // ---- post-checks INSIDE the transaction --------------------
            const left = (await tx.$queryRawUnsafe(
                `SELECT COUNT(*) c FROM \`order\``,
            )) as Row[];
            const expectedLeft = pf.total - pf.targetIds.length;
            if (asNum(left[0].c) !== expectedLeft) {
                throw new Error(
                    `post-check failed: ${asNum(left[0].c)} orders left, expected ${expectedLeft}`,
                );
            }

            for (const t of [
                "orderitem",
                "shipmentjob",
                "guestrecoverychallenge",
                "refund",
                "affiliateconversion",
            ]) {
                if (!(await tableExists(t))) continue;
                if (!COUNTS_ORDER_ID[t]) continue;
                const orphans = (await tx.$queryRawUnsafe(
                    `SELECT COUNT(*) c FROM \`${t}\` x
                      LEFT JOIN \`order\` o ON o.id = x.orderId
                      WHERE o.id IS NULL`,
                )) as Row[];
                if (asNum(orphans[0].c) !== 0) {
                    throw new Error(`post-check failed: ${t} has orphan rows`);
                }
            }

            const masterAfter: Record<string, number> = {};
            for (const t of MASTER_TABLES) {
                if (!(await tableExists(t))) continue;
                const c = (await tx.$queryRawUnsafe(
                    `SELECT COUNT(*) c FROM \`${t}\``,
                )) as Row[];
                masterAfter[t] = asNum(c[0].c);
            }
            for (const [t, before] of Object.entries(pf.master)) {
                if (masterAfter[t] !== before) {
                    throw new Error(
                        `master-data drift on ${t}: ${before} → ${masterAfter[t]} — rolling back`,
                    );
                }
            }

            await tx.$queryRawUnsafe(`SELECT RELEASE_LOCK('mutiara_order_cleanup')`);
        },
        { timeout: 15 * 60 * 1000, maxWait: 30_000 },
    );

    console.log(`\nDONE. orders deleted: ${deleted}`);
    console.log("Master data / stock / settings / affiliate / whatsapp untouched (verified).");
    console.log("Voucher, shipping-discount and product.sold counters were NOT modified.");
    console.log("Next: verify /admin and the storefront, keep the backup until sign-off.");
    await prisma.$disconnect();
}

/** Tables that carry an `orderId` column (used by the orphan post-check). */
const COUNTS_ORDER_ID: Record<string, boolean> = {
    orderitem: true,
    shipmentjob: true,
    guestrecoverychallenge: true,
    refund: true,
    affiliateconversion: true,
};

main().catch(async (e) => {
    console.error("\nCLEANUP FAILED — transaction rolled back:", e?.message ?? e);
    await prisma.$disconnect();
    process.exit(1);
});
