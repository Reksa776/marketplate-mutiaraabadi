/**
 * ============================================================================
 * E2E — scripts/order-cascade-cleanup.ts
 * ============================================================================
 *
 * Integration test on a DISPOSABLE MariaDB database. Production is never
 * touched: the test creates `toko_cleanup_test_<ts>`, applies the project
 * migrations to it, seeds a tiny fixture, runs the CLI, then drops it.
 *
 * Run:
 *   DATABASE_URL="mysql://user:pass@localhost:3306/toko" \
 *     npx tsx __tests__/order-cleanup/order-cascade-cleanup.e2e.ts
 *
 * Requires: local MariaDB user with CREATE/DROP DATABASE + prisma CLI.
 * The test prints only aggregate counts, never row contents.
 */
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { gzipSync } from "zlib";
import { PrismaClient } from "@prisma/client";

/* ------------------------------------------------------------------ helpers */

let passed = 0;
let failed = 0;

function check(condition: boolean, name: string, detail = "") {
    if (condition) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

function eq(actual: unknown, expected: unknown, name: string) {
    check(
        String(actual) === String(expected),
        name,
        `expected=${expected} actual=${actual}`,
    );
}

const BASE_URL = process.env.DATABASE_URL ?? "";
if (!BASE_URL) {
    console.error("DATABASE_URL is required (point it at the dev database).");
    process.exit(2);
}

const base = new URL(BASE_URL);
const DB_NAME = `toko_cleanup_test_${Date.now().toString(36)}`;
if (!/^[a-z0-9_]+$/.test(DB_NAME)) {
    console.error("unexpected test database name");
    process.exit(2);
}

function urlFor(db: string): string {
    const u = new URL(BASE_URL);
    u.pathname = `/${db}`;
    return u.toString();
}

/* tsx tidak selalu ada di node_modules (dipakai lewat npx); --no-install
 * memastikan tidak ada unduhan jaringan saat test berjalan. */
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const CLI = resolve(process.cwd(), "scripts/order-cascade-cleanup.ts");
const TMP = mkdtempSync(join(tmpdir(), "order-cleanup-test-"));

type Run = { code: number; stdout: string; stderr: string };

function runCli(args: string[], db = DB_NAME): Run {
    const r = spawnSync(NPX, ["--no-install", "tsx", CLI, ...args], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: urlFor(db), NODE_ENV: "test" },
        timeout: 180_000,
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runNodeBin(bin: string, args: string[], env: NodeJS.ProcessEnv) {
    const r = spawnSync(bin, args, {
        cwd: process.cwd(),
        encoding: "utf8",
        env,
        timeout: 300_000,
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

async function count(c: PrismaClient, sql: string): Promise<number> {
    const r = (await c.$queryRawUnsafe(sql)) as Array<{ c: bigint | number }>;
    return Number(r[0].c);
}

/* --------------------------------------------------------------------- seed */

const SEED_SQL = `
INSERT INTO user (id, name, email, role, createdAt, updatedAt) VALUES
  ('u_admin_test', 'Admin Test', 'admin@example.test', 'ADMIN', NOW(3), NOW(3)),
  ('u_cust_test',  'Cust Test',  'cust@example.test',  'CUSTOMER', NOW(3), NOW(3));

INSERT INTO product (id, name, slug, sold, rating, bestseller, isArchived, createdAt, updatedAt)
VALUES (1, 'Produk Uji', 'produk-uji', 4, 0, 0, 0, NOW(3), NOW(3));

INSERT INTO productvariant (id, name, price, stock, productId, createdAt, updatedAt, weight)
VALUES (1, 'Varian Uji', 50000, 10, 1, NOW(3), NOW(3), 100);

INSERT INTO storesetting (id, storeName, address, createdAt, updatedAt)
VALUES (1, 'Toko Uji', 'Alamat Uji', NOW(3), NOW(3));

INSERT INTO voucher (id, code, type, value, usedCount, isActive, createdAt, updatedAt)
VALUES (1, 'UJI10', 'FIXED', 1000, 1, 1, NOW(3), NOW(3));

INSERT INTO cart (id, userId, createdAt, updatedAt)
VALUES (1, 'u_cust_test', NOW(3), NOW(3));
INSERT INTO cartitem (id, cartId, productId, variantId, quantity, createdAt, updatedAt)
VALUES (1, 1, 1, 1, 1, NOW(3), NOW(3));

INSERT INTO \`order\`
  (id, userId, orderNumber, recipientName, phone, address, subtotal, shippingCost, total,
   status, paymentMethod, paymentStatus, createdAt, updatedAt)
VALUES
  (1001, 'u_cust_test', 'TEST-ORDER-1', 'Cust Test', '0800000000', 'Alamat Uji',
   50000, 10000, 60000, 'COMPLETED', 'BANK_TRANSFER', 'PAID', NOW(3), NOW(3)),
  (1002, 'u_cust_test', 'TEST-ORDER-2', 'Cust Test', '0800000000', 'Alamat Uji',
   50000, 0, 50000, 'COMPLETED', 'COD', 'UNPAID', NOW(3), NOW(3));

INSERT INTO orderitem
  (id, orderId, productId, variantId, productName, variantName, price, quantity, subtotal)
VALUES
  (1, 1001, 1, 1, 'Produk Uji', 'Varian Uji', 50000, 1, 50000),
  (2, 1002, 1, 1, 'Produk Uji', 'Varian Uji', 50000, 1, 50000);

INSERT INTO affiliateprofile (id, userId, status, affiliateCode, commissionRate, createdAt, updatedAt)
VALUES (1, 'u_cust_test', 'APPROVED', 'AFF-UJI', 5.00, NOW(3), NOW(3));

INSERT INTO affiliateconversion
  (id, affiliateId, orderId, affiliateCode, orderSubtotal, commissionRate, commissionAmount, status, createdAt, updatedAt)
VALUES (1, 1, 1001, 'AFF-UJI', 50000, 5.00, 2500, 'CANCELLED', NOW(3), NOW(3));

INSERT INTO refund (id, orderId, amount, status, requestedBy, createdAt, updatedAt)
VALUES (1, 1001, 60000, 'COMPLETED', 'ADMIN', NOW(3), NOW(3));

INSERT INTO shipmentjob
  (id, orderId, status, stage, attempts, maxAttempts, nextAttemptAt, createdAt, updatedAt)
VALUES (1, 1001, 'DONE', 'CREATE', 0, 6, NOW(3), NOW(3), NOW(3));

INSERT INTO notification
  (id, orderId, channel, notificationType, recipient, idempotencyKey, payload, status, createdAt, updatedAt)
VALUES
  (1, 1001, 'whatsapp', 'ORDER_STATUS_CHANGED', '0800000000', 'idem-1', '{"orderNumber":"TEST-ORDER-1"}', 'SENT', NOW(3), NOW(3)),
  (2, NULL, 'whatsapp', 'ORDER_STATUS_CHANGED', '0800000000', 'idem-2', '{"orderNumber":"OLD"}', 'FAILED', NOW(3), NOW(3));

INSERT INTO guestrecoverychallenge
  (id, orderId, orderNumber, channel, contactChannel, contactHash, codeHash, expiresAt, createdAt, updatedAt)
VALUES ('grc-1', 1001, 'TEST-ORDER-1', 'whatsapp', 'phone', 'hash-contact', 'hash-code', DATE_ADD(NOW(3), INTERVAL 10 MINUTE), NOW(3), NOW(3));

INSERT INTO adminauditlog (id, adminId, action, entityType, entityId, description, createdAt)
VALUES (1, 'u_admin_test', 'ORDER_STATUS_CHANGED', 'Order', 1001, 'fixture', NOW(3));

INSERT INTO spinwheelcampaign (id, name, slug, minimumSpend, maxSpinsPerUser, startAt, endAt, isActive, createdAt, updatedAt)
VALUES (1, 'Spin Uji', 'spin-uji', 0, 0, '2026-01-01', '2030-01-01', 1, NOW(3), NOW(3));
INSERT INTO spinwheelreward (id, campaignId, name, type, value, weight, usedQuantity, isActive, createdAt, updatedAt)
VALUES (1, 1, 'Diskon', 'FIXED', 1000, 1, 0, 1, NOW(3), NOW(3));
INSERT INTO spinwheelspin (id, campaignId, userId, ownerKey, rewardId, status, createdAt, updatedAt)
VALUES (1, 1, 'u_cust_test', 'user:u_cust_test', 1, 'AVAILABLE', NOW(3), NOW(3));
`;

/* ------------------------------------------------------------------- script */

async function main() {
    console.log("=".repeat(70));
    console.log("E2E: order-cascade-cleanup (disposable database)");
    console.log("=".repeat(70));

    const server = new PrismaClient({ datasources: { db: { url: urlFor("mysql") } } });
    await server.$executeRawUnsafe(`CREATE DATABASE \`${DB_NAME}\``);

    let db: PrismaClient | null = null;
    try {
        /*
         * Struktur DB disposable dibuat dari prisma/schema.prisma (bukan dari
         * migration: baseline proyek tidak lengkap untuk DB kosong — temuan
         * audit). Ini hanya menyentuh database uji, tidak pernah dev/prod.
         */
        const push = runNodeBin(
            resolve(process.cwd(), "node_modules/.bin/prisma"),
            ["db", "push", "--skip-generate"],
            { ...process.env, DATABASE_URL: urlFor(DB_NAME) },
        );
        if (push.code !== 0) {
            console.error(push.out.slice(-4000));
            throw new Error("prisma db push failed on the disposable DB");
        }

        db = new PrismaClient({ datasources: { db: { url: urlFor(DB_NAME) } } });

        /*
         * Fixture metadata migrasi: tandai semua folder migration sebagai
         * applied supaya validasi schema/migration CLI berstatus READY.
         */
        await db.$executeRawUnsafe(`
          CREATE TABLE \`_prisma_migrations\` (
            id VARCHAR(36) NOT NULL PRIMARY KEY,
            checksum VARCHAR(64) NOT NULL,
            finished_at DATETIME(3) NULL,
            migration_name VARCHAR(255) NOT NULL,
            logs TEXT NULL,
            rolled_back_at DATETIME(3) NULL,
            started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            applied_steps_count INT UNSIGNED NOT NULL DEFAULT 0
          ) ENGINE=InnoDB
        `);
        const migrationNames = readdirSync(resolve(process.cwd(), "prisma/migrations"), {
            withFileTypes: true,
        })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
        for (const [i, name] of migrationNames.entries()) {
            await db.$executeRawUnsafe(
                `INSERT INTO \`_prisma_migrations\`
                   (id, checksum, finished_at, migration_name, applied_steps_count)
                 VALUES (?, ?, NOW(3), ?, 1)`,
                `fixture-${String(i).padStart(3, "0")}`,
                "0".repeat(64),
                name,
            );
        }

        // $executeRawUnsafe menolak multi-statement: kirim satu per satu.
        for (const stmt of SEED_SQL.split(/;\s*\n/)
            .map((s) => s.trim())
            .filter(Boolean)) {
            await db.$executeRawUnsafe(stmt);
        }

        const baseline = {
            orders: await count(db, "SELECT COUNT(*) c FROM `order`"),
            items: await count(db, "SELECT COUNT(*) c FROM orderitem"),
            users: await count(db, "SELECT COUNT(*) c FROM user"),
            products: await count(db, "SELECT COUNT(*) c FROM product"),
            variants: await count(db, "SELECT COUNT(*) c FROM productvariant"),
            settings: await count(db, "SELECT COUNT(*) c FROM storesetting"),
            vouchers: await count(db, "SELECT COUNT(*) c FROM voucher"),
            audit: await count(db, "SELECT COUNT(*) c FROM adminauditlog"),
            spins: await count(db, "SELECT COUNT(*) c FROM spinwheelspin"),
            unlinkedNotif: await count(db, "SELECT COUNT(*) c FROM notification WHERE orderId IS NULL"),
            fkConstraints: await count(
                db,
                `SELECT COUNT(*) c FROM information_schema.KEY_COLUMN_USAGE
                  WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
            ),
        };

        /* ------------------------------------------ 1. default is dry-run */
        const plain = runCli([]);
        eq(plain.code, 0, "default run exits 0");
        check(plain.stdout.includes("mode        : dry-run"), "default mode is dry-run");
        check(plain.stdout.includes("status      : READY"), "clean fixture is READY");

        const json1 = runCli(["--report-json"]);
        const r1 = JSON.parse(json1.stdout);
        eq(r1.mode, "dry-run", "report-json mode dry-run");
        eq(r1.status, "READY", "report-json status READY");
        eq(r1.counts.orders, baseline.orders, "dry-run sees all orders");
        eq(r1.tables.delete.find((t: any) => t.table === "order").scopeRows, baseline.orders, "delete plan covers all orders");

        eq(await count(db, "SELECT COUNT(*) c FROM `order`"), baseline.orders, "dry-run changed nothing");

        /* ---------------------------- 2. repeated dry-run is idempotent */
        const json2 = runCli(["--report-json"]);
        const r2 = JSON.parse(json2.stdout);
        eq(r2.fingerprint, r1.fingerprint, "fingerprint is stable across dry-runs");
        eq(r2.counts.totalRowsToDelete, r1.counts.totalRowsToDelete, "row target is stable");
        eq(await count(db, "SELECT COUNT(*) c FROM `order`"), baseline.orders, "second dry-run changed nothing");

        /* ------------------------------------ 3. execute without any gate */
        const noGate = runCli(["--execute"]);
        eq(noGate.code, 2, "execute without gates is refused");
        check(
            noGate.stderr.includes("EXECUTE DITOLAK"),
            "refusal is explicit on stderr",
        );
        eq(await count(db, "SELECT COUNT(*) c FROM `order`"), baseline.orders, "refused execute changed nothing");

        /* -------------------------------------------- 4. wrong confirm */
        const badConfirm = runCli([
            "--execute",
            "--confirm-all-orders=DELETE-SOME-ORDERS",
            `--database-fingerprint=${r1.fingerprint}`,
            "--maintenance-confirmed",
            "--writers-stopped",
            "--mengantar-clear",
            "--obligations-reconciled",
            "--i-understand-production",
        ]);
        eq(badConfirm.code, 2, "wrong confirmation string is refused");

        /* ------------------------------------------ 5. wrong fingerprint */
        const badFp = runCli([
            "--execute",
            "--confirm-all-orders=DELETE-ALL-ORDERS",
            "--database-fingerprint=deadbeefdeadbeef",
            "--maintenance-confirmed",
            "--writers-stopped",
            "--mengantar-clear",
            "--obligations-reconciled",
            "--i-understand-production",
        ]);
        eq(badFp.code, 2, "wrong fingerprint is refused");
        check(badFp.stderr.includes("database-fingerprint"), "refusal names the fingerprint gate");
        eq(await count(db, "SELECT COUNT(*) c FROM `order`"), baseline.orders, "fingerprint refusal changed nothing");

        /* ---------------------------------------------- 6. backup file */
        const backupPath = join(TMP, "dump.sql.gz");
        const dumpless = gzipSync(Buffer.from("-- MySQL dump (test fixture)\n"));
        writeFileSync(backupPath, dumpless);
        writeFileSync(
            `${backupPath}.sha256`,
            `${createHash("sha256").update(dumpless).digest("hex")}  dump.sql.gz\n`,
        );

        const goodArgs = [
            "--execute",
            "--confirm-all-orders=DELETE-ALL-ORDERS",
            `--database-fingerprint=${r1.fingerprint}`,
            `--backup=${backupPath}`,
            "--maintenance-confirmed",
            "--writers-stopped",
            "--mengantar-clear",
            "--obligations-reconciled",
            "--i-understand-production",
        ];

        /* ------------------------------- 7. corrupt backup is rejected */
        const emptyBackup = join(TMP, "empty.sql.gz");
        writeFileSync(emptyBackup, Buffer.alloc(0));
        const badBackup = runCli(
            goodArgs.map((a) => (a.startsWith("--backup=") ? `--backup=${emptyBackup}` : a)),
        );
        eq(badBackup.code, 2, "empty backup is refused");
        check(badBackup.stderr.includes("backup"), "refusal names the backup gate");
        eq(await count(db, "SELECT COUNT(*) c FROM `order`"), baseline.orders, "backup refusal changed nothing");

        /* --------------------------- 8. unreconciled refund blocks execute */
        await db.$executeRawUnsafe(
            `INSERT INTO refund (id, orderId, amount, status, requestedBy, createdAt, updatedAt)
             VALUES (2, 1002, 1000, 'PENDING', 'ADMIN', NOW(3), NOW(3))`,
        );
        const blockedByRefund = runCli(goodArgs);
        eq(blockedByRefund.code, 2, "unreconciled refund blocks execute");
        check(
            blockedByRefund.stderr.includes("refund PENDING/PROCESSING"),
            "refusal names the refund obligation",
        );
        eq(await count(db, "SELECT COUNT(*) c FROM `order`"), baseline.orders, "obligation refusal changed nothing");
        await db.$executeRawUnsafe(`DELETE FROM refund WHERE id = 2`);

        /* ---------------------------- 9. rollback on mid-transaction error */
        await db.$executeRawUnsafe(
            `CREATE TRIGGER trg_block_orderitem BEFORE DELETE ON orderitem
             FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced failure'`,
        );
        const rollback = runCli(goodArgs);
        check(rollback.code === 1, "mid-transaction failure exits non-zero", `code=${rollback.code}`);
        check(
            (rollback.stderr + rollback.stdout).includes("forced failure") ||
                (rollback.stderr + rollback.stdout).includes("FATAL"),
            "rollback failure is reported",
        );
        eq(await count(db, "SELECT COUNT(*) c FROM `order`"), baseline.orders, "rollback kept every order");
        eq(await count(db, "SELECT COUNT(*) c FROM orderitem"), baseline.items, "rollback kept every item");
        await db.$executeRawUnsafe(`DROP TRIGGER trg_block_orderitem`);

        /* --------- 9b. production flag is mandatory even for a local DB */
        const noProdFlag = runCli(
            goodArgs.filter((a) => a !== "--i-understand-production"),
        );
        eq(noProdFlag.code, 2, "execute without --i-understand-production is refused");
        check(
            noProdFlag.stderr.includes("--i-understand-production"),
            "refusal names the mandatory production flag",
        );
        eq(
            await count(db, "SELECT COUNT(*) c FROM `order`"),
            baseline.orders,
            "production-flag refusal changed nothing",
        );

        /* ------------------------------------------------ 10. real execute */
        const run = runCli(goodArgs);
        check(run.code === 0, "execute succeeds on a clean fixture", `code=${run.code} ${run.stderr.slice(0, 300)}`);

        eq(await count(db, "SELECT COUNT(*) c FROM `order`"), 0, "orders deleted");
        eq(await count(db, "SELECT COUNT(*) c FROM orderitem"), 0, "orderitem deleted");
        eq(await count(db, "SELECT COUNT(*) c FROM refund"), 0, "refund deleted");
        eq(await count(db, "SELECT COUNT(*) c FROM affiliateconversion"), 0, "affiliateconversion deleted");
        eq(await count(db, "SELECT COUNT(*) c FROM shipmentjob"), 0, "shipmentjob deleted");
        eq(await count(db, "SELECT COUNT(*) c FROM guestrecoverychallenge"), 0, "guest recovery deleted");
        eq(await count(db, "SELECT COUNT(*) c FROM notification WHERE orderId IS NOT NULL"), 0, "linked notifications deleted");

        /* ------------------------------------------------- 11. preservation */
        eq(await count(db, "SELECT COUNT(*) c FROM user"), baseline.users, "users preserved");
        eq(await count(db, "SELECT COUNT(*) c FROM product"), baseline.products, "products preserved");
        eq(await count(db, "SELECT COUNT(*) c FROM productvariant"), baseline.variants, "variants preserved");
        eq(await count(db, "SELECT COUNT(*) c FROM productvariant WHERE id=1 AND stock=10"), 1, "stock unchanged");
        eq(await count(db, "SELECT COUNT(*) c FROM storesetting"), baseline.settings, "store settings preserved");
        eq(await count(db, "SELECT COUNT(*) c FROM voucher"), baseline.vouchers, "voucher master preserved");
        eq(await count(db, "SELECT COUNT(*) c FROM adminauditlog"), baseline.audit, "audit log preserved");
        eq(await count(db, "SELECT COUNT(*) c FROM spinwheelspin"), baseline.spins, "spin entitlement preserved");
        eq(await count(db, "SELECT COUNT(*) c FROM notification WHERE orderId IS NULL"), baseline.unlinkedNotif, "unlinked notifications preserved");
        eq(await count(db, "SELECT COUNT(*) c FROM cart"), 1, "cart preserved");
        eq(await count(db, "SELECT COUNT(*) c FROM account"), 0, "no unrelated rows touched");

        /* ------------------------------------------------- 12. FK integrity */
        const fk = await count(
            db,
            `SELECT COUNT(*) c FROM information_schema.KEY_COLUMN_USAGE
              WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
        );
        eq(fk, baseline.fkConstraints, "foreign key constraints still present");
        const orphans = await count(
            db,
            `SELECT COUNT(*) c FROM orderitem x LEFT JOIN \`order\` o ON o.id=x.orderId WHERE o.id IS NULL`,
        );
        eq(orphans, 0, "no orphan orderitem");

        /* ------------------------------------- 13. no external integrations */
        const src = readFileSync(CLI, "utf8");
        // Komentar tidak dieksekusi: periksa kode saja.
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
        check(!/from\s+["'][^"']*(axios|mengantar|baileys|whatsapp|node-fetch)[^"']*["']/i.test(code), "no external service imports");
        check(!/\bfetch\s*\(/.test(code), "no fetch() calls");
        check(!/child_process/.test(code), "no process spawning");
        check(!/FOREIGN_KEY_CHECKS\s*=\s*0/i.test(code), "never disables FK checks");
        check(!/\bTRUNCATE\s+(TABLE\s+)?[`"\w]/i.test(code), "never uses TRUNCATE");
        check(!/\bDROP\s+DATABASE\b/i.test(code), "never drops a database");

        /* ================================ 14. single-order mode */
        await db.$executeRawUnsafe(
            `INSERT INTO \`order\`
               (id, userId, orderNumber, recipientName, phone, address, subtotal, shippingCost, total,
                status, paymentMethod, paymentStatus, createdAt, updatedAt)
             VALUES
               (2001, 'u_cust_test', 'TEST-SINGLE-1', 'Cust Test', '0800000000', 'Alamat Uji',
                50000, 10000, 60000, 'COMPLETED', 'BANK_TRANSFER', 'PAID', NOW(3), NOW(3)),
               (2002, 'u_cust_test', 'TEST-SINGLE-2', 'Cust Test', '0800000000', 'Alamat Uji',
                50000, 0, 50000, 'COMPLETED', 'COD', 'UNPAID', NOW(3), NOW(3))`,
        );
        await db.$executeRawUnsafe(
            `INSERT INTO orderitem
               (id, orderId, productId, variantId, productName, variantName, price, quantity, subtotal)
             VALUES
               (21, 2001, 1, 1, 'Produk Uji', 'Varian Uji', 50000, 1, 50000),
               (22, 2002, 1, 1, 'Produk Uji', 'Varian Uji', 50000, 1, 50000)`,
        );
        await db.$executeRawUnsafe(
            `INSERT INTO refund (id, orderId, amount, status, requestedBy, createdAt, updatedAt)
             VALUES (3, 2001, 60000, 'COMPLETED', 'ADMIN', NOW(3), NOW(3))`,
        );
        await db.$executeRawUnsafe(
            `INSERT INTO notification
               (id, orderId, channel, notificationType, recipient, idempotencyKey, payload, status, createdAt, updatedAt)
             VALUES (3, 2001, 'whatsapp', 'ORDER_STATUS_CHANGED', '0800000000', 'idem-3', '{}', 'SENT', NOW(3), NOW(3))`,
        );

        const singleDry = runCli(["--order-id=2001", "--report-json"]);
        eq(singleDry.code, 0, "single-order dry-run exits 0");
        const s1 = JSON.parse(singleDry.stdout);
        eq(s1.scope.mode, "single", "scope is reported as single");
        eq(s1.scope.orderId, 2001, "scope carries the order id");
        eq(s1.counts.orders, 1, "single scope counts exactly one order");
        eq(
            s1.tables.delete.find((t: any) => t.table === "order").scopeRows,
            1,
            "order plan covers one row only",
        );
        eq(
            s1.tables.delete.find((t: any) => t.table === "orderitem").scopeRows,
            1,
            "item plan is scoped to the selected order",
        );
        eq(
            s1.tables.delete.find((t: any) => t.table === "refund").scopeRows,
            1,
            "refund plan is scoped to the selected order",
        );
        eq(
            s1.tables.delete.find((t: any) => t.table === "notification").scopeRows,
            1,
            "notification plan is scoped to the selected order",
        );
        check(
            s1.fingerprint !== r1.fingerprint,
            "single fingerprint differs from the all-orders fingerprint",
        );
        eq(await count(db, "SELECT COUNT(*) c FROM `order`"), 2, "single dry-run changed nothing");

        const singleBase = [
            "--execute",
            "--order-id=2001",
            `--database-fingerprint=${s1.fingerprint}`,
            `--backup=${backupPath}`,
            "--maintenance-confirmed",
            "--writers-stopped",
            "--mengantar-clear",
            "--obligations-reconciled",
            "--i-understand-production",
        ];

        const noSingleConfirm = runCli(singleBase);
        eq(noSingleConfirm.code, 2, "single execute without --confirm-order is refused");
        check(
            noSingleConfirm.stderr.includes("confirm-order=<id>"),
            "refusal names the single-order confirmation gate",
        );

        const wrongSingleConfirm = runCli([...singleBase, "--confirm-order=2002"]);
        eq(wrongSingleConfirm.code, 2, "wrong --confirm-order is refused");

        const mixedFlags = runCli([
            ...singleBase,
            "--confirm-order=2001",
            "--confirm-all-orders=DELETE-ALL-ORDERS",
        ]);
        eq(mixedFlags.code, 2, "--order-id plus bulk confirmation is refused");
        eq(await count(db, "SELECT COUNT(*) c FROM `order`"), 2, "refused single executes changed nothing");

        const missingOrder = runCli(["--order-id=999999", "--report-json"]);
        eq(missingOrder.code, 2, "unknown order id is BLOCKED");
        const missing = JSON.parse(missingOrder.stdout);
        eq(missing.status, "BLOCKED", "unknown order id reports BLOCKED");
        check(
            missing.reasons.some((x: string) => x.includes("999999") && x.includes("tidak ditemukan")),
            "unknown order id reason is explicit",
        );

        // Shipment yang sudah dibuat provider harus memblokir order itu saja.
        await db.$executeRawUnsafe(
            `UPDATE \`order\` SET providerShipmentId='TEST-PROVIDER-1', shipmentStatus='CREATED'
              WHERE id=2002`,
        );
        const providerBlocked = runCli(["--order-id=2002", "--report-json"]);
        eq(providerBlocked.code, 2, "order with a provider shipment is BLOCKED");
        const pb = JSON.parse(providerBlocked.stdout);
        check(
            pb.reasons.some((x: string) => x.includes("providerShipmentId")),
            "BLOCKED reason names the provider shipment",
        );
        eq(
            await count(db, "SELECT COUNT(*) c FROM `order` WHERE id=2002"),
            1,
            "provider shipment order is untouched",
        );
        await db.$executeRawUnsafe(
            `UPDATE \`order\` SET providerShipmentId=NULL, shipmentStatus=NULL WHERE id=2002`,
        );

        /* ------------------------- 15. real single-order execute */
        const singleRun = runCli([...singleBase, "--confirm-order=2001"]);
        check(
            singleRun.code === 0,
            "single-order execute succeeds",
            `code=${singleRun.code} ${singleRun.stderr.slice(0, 300)}`,
        );
        eq(
            await count(db, "SELECT COUNT(*) c FROM `order` WHERE id=2001"),
            0,
            "selected order deleted",
        );
        eq(
            await count(db, "SELECT COUNT(*) c FROM `order` WHERE id=2002"),
            1,
            "other order preserved",
        );
        eq(await count(db, "SELECT COUNT(*) c FROM orderitem"), 1, "only the selected item was deleted");
        eq(await count(db, "SELECT COUNT(*) c FROM orderitem WHERE orderId=2002"), 1, "remaining item belongs to the other order");
        eq(await count(db, "SELECT COUNT(*) c FROM refund"), 0, "refund of the selected order deleted");
        eq(await count(db, "SELECT COUNT(*) c FROM notification WHERE orderId=2001"), 0, "notification of the selected order deleted");
        eq(await count(db, "SELECT COUNT(*) c FROM notification WHERE orderId IS NULL"), baseline.unlinkedNotif, "unlinked notification still preserved");
        eq(await count(db, "SELECT COUNT(*) c FROM user"), baseline.users, "users unchanged after single delete");
        eq(await count(db, "SELECT COUNT(*) c FROM product"), baseline.products, "products unchanged after single delete");
        eq(await count(db, "SELECT COUNT(*) c FROM productvariant"), baseline.variants, "variants unchanged after single delete");
        eq(await count(db, "SELECT COUNT(*) c FROM productvariant WHERE id=1 AND stock=10"), 1, "stock unchanged after single delete");
        eq(await count(db, "SELECT COUNT(*) c FROM adminauditlog"), baseline.audit, "audit log unchanged after single delete");
        eq(await count(db, "SELECT COUNT(*) c FROM spinwheelspin"), baseline.spins, "spin entitlement unchanged after single delete");
        eq(
            await count(
                db,
                `SELECT COUNT(*) c FROM information_schema.KEY_COLUMN_USAGE
                  WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
            ),
            baseline.fkConstraints,
            "foreign keys still present after single delete",
        );

        const reRun = runCli([...singleBase, "--confirm-order=2001"]);
        eq(reRun.code, 2, "re-running the same single delete is BLOCKED");
        eq(await count(db, "SELECT COUNT(*) c FROM `order`"), 1, "failed re-run changed nothing");

        /* ============================= 16. explicit override (dummy data) */
        await db.$executeRawUnsafe(
            `INSERT INTO refund (id, orderId, amount, status, requestedBy, createdAt, updatedAt)
             VALUES (4, 2002, 1000, 'PENDING', 'ADMIN', NOW(3), NOW(3))`,
        );
        await db.$executeRawUnsafe(
            `UPDATE \`order\` SET providerShipmentId='TEST-PROVIDER-2', shipmentStatus='CREATED'
              WHERE id=2002`,
        );

        const blockedNoToken = runCli(["--order-id=2002", "--report-json"]);
        eq(blockedNoToken.code, 2, "open obligations block without a token");
        const bnt = JSON.parse(blockedNoToken.stdout);
        check(
            bnt.reasons.some((x: string) => x.includes("refund")),
            "refund blocker is reported",
        );
        check(
            bnt.reasons.some((x: string) => x.includes("providerShipmentId")),
            "provider shipment blocker is reported",
        );

        const onlyFinancial = runCli([
            "--order-id=2002",
            "--report-json",
            "--discard-open-obligations=DISCARD-OPEN-OBLIGATIONS",
        ]);
        eq(onlyFinancial.code, 2, "financial token alone is still blocked by the provider shipment");
        check(
            JSON.parse(onlyFinancial.stdout).reasons.some((x: string) =>
                x.includes("providerShipmentId"),
            ),
            "provider blocker survives the financial token",
        );

        const bothTokens = runCli([
            "--order-id=2002",
            "--report-json",
            "--discard-open-obligations=DISCARD-OPEN-OBLIGATIONS",
            "--discard-provider-shipments=DISCARD-PROVIDER-SHIPMENTS",
        ]);
        eq(bothTokens.code, 0, "both tokens make the order READY");
        const bt = JSON.parse(bothTokens.stdout);
        eq(bt.status, "READY", "override reports READY");
        eq(bt.overrides.openObligations, true, "financial override is recorded");
        eq(bt.overrides.providerShipments, true, "provider override is recorded");
        check(
            bt.warnings.some((w: string) => w.includes("OVERRIDE")),
            "override is surfaced as a warning",
        );

        const overrideRun = runCli([
            "--execute",
            "--order-id=2002",
            `--database-fingerprint=${bt.fingerprint}`,
            `--backup=${backupPath}`,
            "--confirm-order=2002",
            "--maintenance-confirmed",
            "--writers-stopped",
            "--mengantar-clear",
            "--obligations-reconciled",
            "--i-understand-production",
            "--discard-open-obligations=DISCARD-OPEN-OBLIGATIONS",
            "--discard-provider-shipments=DISCARD-PROVIDER-SHIPMENTS",
        ]);
        check(
            overrideRun.code === 0,
            "override execute succeeds",
            `code=${overrideRun.code} ${overrideRun.stderr.slice(0, 300)}`,
        );
        eq(await count(db, "SELECT COUNT(*) c FROM `order`"), 0, "all orders deleted with override");
        eq(await count(db, "SELECT COUNT(*) c FROM orderitem"), 0, "all items deleted with override");
        eq(await count(db, "SELECT COUNT(*) c FROM refund"), 0, "pending refund deleted with override");
        eq(await count(db, "SELECT COUNT(*) c FROM user"), baseline.users, "users survive the override");
        eq(await count(db, "SELECT COUNT(*) c FROM product"), baseline.products, "products survive the override");
        eq(await count(db, "SELECT COUNT(*) c FROM storesetting"), baseline.settings, "settings survive the override");
    } finally {
        try {
            if (db) await db.$disconnect();
            await server.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
        } catch (e) {
            console.error(`cleanup warning: ${(e as Error).message}`);
        }
        await server.$disconnect();
        rmSync(TMP, { recursive: true, force: true });
    }

    console.log("\n" + "-".repeat(70));
    console.log(`RESULT: ${passed} passed, ${failed} failed`);
    console.log("-".repeat(70));
    if (failed > 0) process.exit(1);
}

main().catch((e) => {
    console.error(`FATAL: ${e?.message ?? e}`);
    process.exit(1);
});
