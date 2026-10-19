/**
 * ============================================================================
 * ORDER CASCADE CLEANUP — CLI
 * ============================================================================
 *
 * Membersihkan SELURUH data order + turunan eksklusifnya, berdasarkan schema
 * Prisma dan foreign key AKTUAL di database. Master data (user, produk, stok,
 * settings, kredensial, sesi WhatsApp) TIDAK pernah dihapus.
 *
 * DEFAULT: DRY-RUN, dan default scope = SEMUA order.
 *
 * Scope:
 *   (tanpa flag)              semua order  → butuh --confirm-all-orders=DELETE-ALL-ORDERS
 *   --order-id=<id>           satu order   → butuh --confirm-order=<id>
 *   Scope ikut masuk fingerprint, jadi fingerprint mode "single" tidak bisa
 *   dipakai untuk mode "all" (dan sebaliknya).
 *
 * Tidak ada DELETE tanpa SEMUA gate berikut:
 *   --execute
 *   --confirm-all-orders=DELETE-ALL-ORDERS   (scope semua)  ATAU
 *   --confirm-order=<id>                      (scope satu order)
 *   --database-fingerprint=<fingerprint dari dry-run>
 *   --backup=<file dump terverifikasi>
 *   --maintenance-confirmed
 *   --writers-stopped
 *   --mengantar-clear
 *   --obligations-reconciled
 *   --i-understand-production   (wajib untuk SEMUA eksekusi, termasuk DB lokal)
 *
 * Mode:
 *   --dry-run                 (default; boleh ditulis eksplisit)
 *   --report-json             JSON ke stdout (tanpa teks lain)
 *   --report-json=<path>      JSON ke file + ringkasan manusia
 *   --execute                 eksekusi (butuh semua gate)
 *
 * Aturan keras:
 *   - hanya SELECT pada dry-run;
 *   - tanpa TRUNCATE, tanpa DROP DATABASE, tanpa mematikan FOREIGN_KEY_CHECKS;
 *   - child dihapus sebelum parent mengikuti dependency graph;
 *   - satu transaksi InnoDB; gagal = rollback;
 *   - tidak memanggil Mengantar / WhatsApp / payment gateway;
 *   - tidak menghapus file upload / direktori auth;
 *   - tidak mencetak DATABASE_URL, password, token, atau PII pelanggan.
 */
import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";
import { readFileSync, statSync, existsSync, readdirSync, writeFileSync } from "fs";
import { resolve } from "path";

/* ==========================================================================
 * 1. KONSTANTA KLASIFIKASI (nama tabel nyata dari schema + information_schema)
 * ========================================================================== */

const ORDER_TABLE = "order";

/**
 * Tabel yang seluruh/ sebagian barisnya adalah turunan EKSKLUSIF order dan
 * aman dihapus. Predikat membatasi baris campuran (mis. notification).
 */
const DELETE_RULES: Record<
    string,
    { predicate: (alias: string) => string; reason: string }
> = {
    notification: {
        predicate: (a) => `${a}.orderId IS NOT NULL`,
        reason: "payload notifikasi memuat data order (nomor, total, item)",
    },
    guestrecoverychallenge: {
        predicate: (a) => `${a}.orderId IS NOT NULL`,
        reason: "OTP pemulihan order, sekali pakai",
    },
    shipmentjob: {
        predicate: (a) => `${a}.orderId IS NOT NULL`,
        reason: "outbox shipment turunan order",
    },
    refund: {
        predicate: (a) => `${a}.orderId IS NOT NULL`,
        reason: "refund hanya ada karena order",
    },
    affiliateconversion: {
        predicate: (a) => `${a}.orderId IS NOT NULL`,
        reason: "konversi komisi per order",
    },
    orderitem: {
        predicate: (a) => `${a}.orderId IS NOT NULL`,
        reason: "item order (snapshot harga/nama)",
    },
    order: {
        predicate: () => "1=1",
        reason: "record order itu sendiri",
    },
};

/** Tabel yang WAJIB dipertahankan (master / konfigurasi / audit / entitlement). */
const PRESERVE_TABLES = new Set<string>([
    "user",
    "account",
    "session",
    "verificationtoken",
    "product",
    "productvariant",
    "cart",
    "cartitem",
    "useraddress",
    "storesetting",
    "province",
    "regency",
    "district",
    "village",
    "rajaongkirregion",
    "voucher",
    "voucherproduct",
    "vouchercategory",
    "shippingdiscount",
    "bulkdiscount",
    "productdiscount",
    "campaign",
    "campaignproduct",
    "campaigncategory",
    "promotion",
    "flashsale",
    "flashsalepurchase",
    "spinwheelcampaign",
    "spinwheelreward",
    "spinwheelspin",
    "broadcast",
    "affiliateprofile",
    "affiliatekyc",
    "affiliateclick",
    "affiliatepayout",
    "adminauditlog",
    "voucheruserusage",
    "whatsapp_chat_state",
    "whatsapp_inbound_message",
    "_prisma_migrations",
]);

/**
 * Tabel campuran / ambigu: TIDAK dihapus, tetapi dilaporkan sebagai keputusan
 * manual (counter, audit, entitlement, kuota).
 */
const AMBIGUOUS_TABLES = new Set<string>([
    "adminauditlog",
    "voucheruserusage",
    "flashsalepurchase",
    "spinwheelspin",
    "notification",
    "whatsapp_chat_state",
]);

/* ==========================================================================
 * 2. ARGUMEN
 * ========================================================================== */

type Args = {
    dryRun: boolean;
    execute: boolean;
    reportJson: string | true | null;
    confirm: string | null;
    fingerprint: string | null;
    backup: string | null;
    maintenance: boolean;
    writersStopped: boolean;
    mengantarClear: boolean;
    obligationsReconciled: boolean;
    batch: number;
    allowProduction: boolean;
    orderId: number | null;
    confirmOrder: string | null;
};

function parseArgs(argv: string[]): Args {
    const has = (f: string) => argv.includes(f);
    const val = (name: string) => {
        const hit = argv.find((a) => a.startsWith(`--${name}=`));
        return hit ? hit.slice(name.length + 3) : null;
    };

    const reportFlag = argv.find((a) => a === "--report-json" || a.startsWith("--report-json="));
    const reportJson: string | true | null = !reportFlag
        ? null
        : reportFlag === "--report-json"
          ? true
          : (reportFlag.split("=").slice(1).join("=") || true);

    const rawOrderId = val("order-id");
    if (rawOrderId !== null && !/^[1-9][0-9]*$/.test(rawOrderId)) {
        process.stderr.write("ERROR: --order-id harus bilangan bulat positif.\n");
        process.exit(2);
    }

    return {
        dryRun: has("--dry-run"),
        execute: has("--execute"),
        reportJson,
        confirm: val("confirm-all-orders"),
        confirmOrder: val("confirm-order"),
        orderId: rawOrderId === null ? null : Number(rawOrderId),
        fingerprint: val("database-fingerprint"),
        backup: val("backup"),
        maintenance: has("--maintenance-confirmed"),
        writersStopped: has("--writers-stopped"),
        mengantarClear: has("--mengantar-clear"),
        obligationsReconciled: has("--obligations-reconciled"),
        batch: Math.max(1, Math.min(1000, Number(val("batch") ?? 250) || 250)),
        allowProduction: has("--i-understand-production"),
    };
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.execute && ARGS.dryRun) {
    process.stderr.write("ERROR: --dry-run dan --execute tidak bisa digabung.\n");
    process.exit(2);
}

if (ARGS.orderId !== null && ARGS.confirm !== null) {
    process.stderr.write(
        "ERROR: --order-id (satu order) tidak boleh digabung dengan --confirm-all-orders.\n",
    );
    process.exit(2);
}

/* ==========================================================================
 * 2b. SCOPE — semua order atau satu order
 * ========================================================================== */

type Scope = { kind: "all" } | { kind: "single"; orderId: number };

const SCOPE: Scope =
    ARGS.orderId === null ? { kind: "all" } : { kind: "single", orderId: ARGS.orderId };

function scopeLabel(): string {
    return SCOPE.kind === "all" ? "all" : `single:${SCOPE.orderId}`;
}

/** Filter baris turunan; `column` default `orderId`. */
function scopeSql(alias: string, column = "orderId"): string {
    if (SCOPE.kind === "all") return "1=1";
    return `${alias}.${column} = ${SCOPE.orderId}`;
}

/** Filter tabel `order` itu sendiri (kolom `id`). */
function orderScopeSql(alias: string): string {
    if (SCOPE.kind === "all") return "1=1";
    return `${alias}.id = ${SCOPE.orderId}`;
}

/* ==========================================================================
 * 3. UTIL
 * ========================================================================== */

const prisma = new PrismaClient({ log: [] });
type Row = Record<string, unknown>;

const READ_ONLY = /^\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN)\b/i;

async function ro<T = Row>(sql: string): Promise<T[]> {
    if (!READ_ONLY.test(sql)) {
        throw new Error(`ro() menolak statement non-read: ${sql.slice(0, 50)}`);
    }
    return (await prisma.$queryRawUnsafe(sql)) as T[];
}

const asNum = (v: unknown): number =>
    typeof v === "bigint" ? Number(v) : Number(v ?? 0);

function sqlIdent(name: string): string {
    // Nama tabel/kolom berasal dari information_schema, tetap divalidasi ketat.
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
        throw new Error(`identifier tidak valid: ${name}`);
    }
    return `\`${name}\``;
}

async function tableExists(t: string): Promise<boolean> {
    const r = await ro(
        `SELECT COUNT(*) c FROM information_schema.TABLES
          WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${t.replace(/'/g, "")}'`,
    );
    return asNum(r[0].c) > 0;
}

function fail(msg: string): never {
    process.stderr.write(`\nERROR: ${msg}\n`);
    process.exit(1);
}

/* ==========================================================================
 * 4. INSPEKSI DATABASE (read-only)
 * ========================================================================== */

type FkEdge = {
    childTable: string;
    childColumn: string;
    parentTable: string;
    parentColumn: string;
    onDelete: string;
    onUpdate: string;
};

type Inspection = {
    dbName: string;
    serverVersion: string;
    fkChecks: number;
    tables: Array<{ name: string; engine: string }>;
    columns: Array<{ table: string; column: string }>;
    fks: FkEdge[];
    migrations: Array<{ name: string; finished: boolean; rolledBack: boolean }>;
    migrationDirs: string[];
    schemaTables: string[];
};

async function inspect(): Promise<Inspection> {
    const meta = (
        await ro(
            `SELECT DATABASE() db, VERSION() v,
                    @@SESSION.foreign_key_checks fk`,
        )
    )[0];

    const tables = (
        await ro(
            `SELECT TABLE_NAME t, ENGINE e FROM information_schema.TABLES
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'
              ORDER BY TABLE_NAME`,
        )
    ).map((r) => ({ name: String(r.t), engine: String(r.e ?? "") }));

    const columns = (
        await ro(
            `SELECT TABLE_NAME t, COLUMN_NAME c
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=DATABASE()
              ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        )
    ).map((r) => ({ table: String(r.t), column: String(r.c) }));

    const fks = (
        await ro(
            `SELECT kcu.TABLE_NAME ct, kcu.COLUMN_NAME cc,
                    kcu.REFERENCED_TABLE_NAME pt, kcu.REFERENCED_COLUMN_NAME pc,
                    rc.DELETE_RULE dr, rc.UPDATE_RULE ur
               FROM information_schema.KEY_COLUMN_USAGE kcu
               JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                 ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
                AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
              WHERE kcu.TABLE_SCHEMA=DATABASE()
                AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
        )
    ).map((r) => ({
        childTable: String(r.ct),
        childColumn: String(r.cc),
        parentTable: String(r.pt),
        parentColumn: String(r.pc),
        onDelete: String(r.dr),
        onUpdate: String(r.ur),
    }));

    let migrations: Inspection["migrations"] = [];
    if (tables.some((t) => t.name === "_prisma_migrations")) {
        migrations = (
            await ro(
                `SELECT migration_name n, finished_at f, rolled_back_at rb
                   FROM _prisma_migrations`,
            )
        ).map((r) => ({
            name: String(r.n),
            finished: r.f !== null,
            rolledBack: r.rb !== null,
        }));
    }

    const migrationDirs = (() => {
        try {
            return readdirSync(resolve(process.cwd(), "prisma/migrations"), {
                withFileTypes: true,
            })
                .filter((d) => d.isDirectory())
                .map((d) => d.name)
                .sort();
        } catch {
            return [];
        }
    })();

    const schemaTables = (() => {
        try {
            const schema = readFileSync(
                resolve(process.cwd(), "prisma/schema.prisma"),
                "utf-8",
            );
            const mapped = [...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]);
            return [...new Set(mapped)].sort();
        } catch {
            return [];
        }
    })();

    return {
        dbName: String(meta.db),
        serverVersion: String(meta.v),
        fkChecks: asNum(meta.fk),
        tables,
        columns,
        fks,
        migrations,
        migrationDirs,
        schemaTables,
    };
}

/* ==========================================================================
 * 5. DEPENDENCY GRAPH
 * ========================================================================== */

type GraphNode = { table: string; depth: number; edge?: FkEdge; via?: string };

function buildGraph(ins: Inspection): {
    nodes: GraphNode[];
    edges: FkEdge[];
    unknown: string[];
} {
    // parent -> children
    const childrenOf = new Map<string, FkEdge[]>();
    for (const fk of ins.fks) {
        const list = childrenOf.get(fk.parentTable) ?? [];
        list.push(fk);
        childrenOf.set(fk.parentTable, list);
    }

    const nodes: GraphNode[] = [{ table: ORDER_TABLE, depth: 0 }];
    const seen = new Set<string>([ORDER_TABLE]);
    const queue: GraphNode[] = [{ table: ORDER_TABLE, depth: 0 }];

    while (queue.length) {
        const cur = queue.shift()!;
        for (const fk of childrenOf.get(cur.table) ?? []) {
            if (seen.has(fk.childTable)) continue;
            seen.add(fk.childTable);
            const node: GraphNode = {
                table: fk.childTable,
                depth: cur.depth + 1,
                edge: fk,
                via: cur.table,
            };
            nodes.push(node);
            queue.push(node);
        }
    }

    // Tabel dengan kolom bernama orderId / *OrderId tetapi tanpa FK = ambigu.
    const fkTables = new Set(ins.fks.map((f) => f.childTable));
    const unknown: string[] = [];
    for (const col of ins.columns) {
        if (col.table === ORDER_TABLE) continue;
        if (!/^orderId$|OrderId$/.test(col.column)) continue;
        // referensi balik yang sah (mis. originalSpinWheelSpinId bukan orderId)
        if (!/order[_]?id$/i.test(col.column)) continue;
        if (!fkTables.has(col.table) && !DELETE_RULES[col.table] && !PRESERVE_TABLES.has(col.table)) {
            unknown.push(col.table);
        }
    }

    return { nodes, edges: ins.fks, unknown: [...new Set(unknown)] };
}

/* ==========================================================================
 * 6. VALIDASI SCHEMA & MIGRATION
 * ========================================================================== */

type SchemaValidation = {
    ok: boolean;
    missingInDb: string[];
    missingMigrations: string[];
    failedMigrations: string[];
    extraTables: string[];
    requiredColumnsMissing: string[];
};

function validateSchema(ins: Inspection): SchemaValidation {
    const dbTables = new Set(ins.tables.map((t) => t.name));
    const mapped = new Set(ins.schemaTables);

    const missingInDb = ins.schemaTables.filter((t) => !dbTables.has(t));

    const applied = new Set(
        ins.migrations.filter((m) => m.finished && !m.rolledBack).map((m) => m.name),
    );
    const missingMigrations = ins.migrationDirs.filter((d) => !applied.has(d));
    // Sebuah nama hanya dianggap gagal bila TIDAK punya percobaan sukses.
    const failedMigrations = [
        ...new Set(
            ins.migrations
                .filter((m) => !m.finished || m.rolledBack)
                .map((m) => m.name),
        ),
    ].filter((n) => !applied.has(n));
    const extraTables = ins.tables
        .map((t) => t.name)
        .filter((t) => !mapped.has(t) && t !== "_prisma_migrations");

    const colSet = new Set(ins.columns.map((c) => `${c.table}.${c.column}`));
    const requiredColumnsMissing: string[] = [];
    const required: Array<[string, string]> = [
        ["order", "id"],
        ["order", "status"],
        ["order", "paymentStatus"],
        ["order", "paymentMethod"],
        ["order", "createdAt"],
        ["orderitem", "orderId"],
        ["shipmentjob", "orderId"],
        ["refund", "orderId"],
        ["affiliateconversion", "orderId"],
        ["guestrecoverychallenge", "orderId"],
        ["notification", "orderId"],
    ];
    for (const [t, c] of required) {
        if (!dbTables.has(t)) {
            requiredColumnsMissing.push(`${t} (tabel tidak ada)`);
            continue;
        }
        if (!colSet.has(`${t}.${c}`)) requiredColumnsMissing.push(`${t}.${c}`);
    }

    return {
        ok:
            missingInDb.length === 0 &&
            missingMigrations.length === 0 &&
            failedMigrations.length === 0 &&
            requiredColumnsMissing.length === 0,
        missingInDb,
        missingMigrations,
        failedMigrations,
        extraTables,
        requiredColumnsMissing,
    };
}

/* ==========================================================================
 * 7. HITUNGAN & PREFLIGHT
 * ========================================================================== */

type Counts = {
    orders: number;
    maxOrderId: number;
    recentOrders: number;
    perDeleteTable: Record<string, number>;
    preserved: Record<string, number>;
    notificationUnlinked: number;
    obligations: Record<string, number>;
    ambiguous: Record<string, number>;
};

async function collectCounts(graph: GraphNode[]): Promise<Counts> {
    const orders = asNum(
        (await ro(
            `SELECT COUNT(*) c FROM ${sqlIdent(ORDER_TABLE)} x WHERE ${orderScopeSql("x")}`,
        ))[0].c,
    );
    const maxOrderId =
        SCOPE.kind === "single"
            ? orders > 0
                ? SCOPE.orderId
                : 0
            : asNum(
                  (await ro(
                      `SELECT COALESCE(MAX(id),0) m FROM ${sqlIdent(ORDER_TABLE)}`,
                  ))[0].m,
              );

    const perDeleteTable: Record<string, number> = {};
    for (const node of graph) {
        const rule = DELETE_RULES[node.table];
        if (!rule) continue;
        const where = rule.predicate("x");
        const scope =
            node.table === ORDER_TABLE ? orderScopeSql("x") : scopeSql("x");
        const r = await ro(
            `SELECT COUNT(*) c FROM ${sqlIdent(node.table)} x WHERE ${where} AND ${scope}`,
        );
        perDeleteTable[node.table] = asNum(r[0].c);
    }

    const preserved: Record<string, number> = {};
    for (const t of [...PRESERVE_TABLES].sort()) {
        if (!(await tableExists(t))) continue;
        const r = await ro(`SELECT COUNT(*) c FROM ${sqlIdent(t)}`);
        preserved[t] = asNum(r[0].c);
    }

    const notificationUnlinked = (await tableExists("notification"))
        ? asNum(
              (await ro(`SELECT COUNT(*) c FROM notification WHERE orderId IS NULL`))[0].c,
          )
        : 0;

    const scalar = async (sql: string): Promise<number> => {
        try {
            const r = await ro(sql);
            return asNum(r[0].c);
        } catch {
            return 0;
        }
    };

    /*
     * Kewajiban dihitung pada scope yang sama dengan penghapusan: mode satu
     * order tidak boleh diblokir oleh kewajiban order lain. Pengecualian:
     * affiliatepayout tidak punya kolom order (level akun) sehingga tetap
     * dihitung global sebagai peringatan saldo.
     */
    const scoped = (column: string) =>
        SCOPE.kind === "single" ? ` AND ${column} = ${SCOPE.orderId}` : "";

    const obligations: Record<string, number> = {
        "refund PENDING/PROCESSING": await scalar(
            `SELECT COUNT(*) c FROM refund WHERE status IN ('PENDING','PROCESSING')${scoped("orderId")}`,
        ),
        "komisi affiliate PENDING/APPROVED/PAID": await scalar(
            `SELECT COUNT(*) c FROM affiliateconversion WHERE status IN ('PENDING','APPROVED','PAID')${scoped("orderId")}`,
        ),
        "affiliate payout PENDING/PROCESSING": await scalar(
            `SELECT COUNT(*) c FROM affiliatepayout WHERE status IN ('PENDING','PROCESSING')`,
        ),
        "ShipmentJob PENDING/PROCESSING": await scalar(
            `SELECT COUNT(*) c FROM shipmentjob WHERE status IN ('PENDING','PROCESSING')${scoped("orderId")}`,
        ),
        "shipment Mengantar aktif": await scalar(
            `SELECT COUNT(*) c FROM ${sqlIdent(ORDER_TABLE)}
              WHERE shipmentStatus IS NOT NULL
                AND shipmentStatus NOT IN ('DELIVERED','CANCELLED','RETURNED','NOT_CREATED')${scoped("id")}`,
        ),
        "order dengan providerShipmentId": await scalar(
            `SELECT COUNT(*) c FROM ${sqlIdent(ORDER_TABLE)} WHERE providerShipmentId IS NOT NULL${scoped("id")}`,
        ),
        "COD belum selesai": await scalar(
            `SELECT COUNT(*) c FROM ${sqlIdent(ORDER_TABLE)}
              WHERE paymentMethod='COD' AND status NOT IN ('COMPLETED','CANCELLED')${scoped("id")}`,
        ),
        "PAID belum COMPLETED": await scalar(
            `SELECT COUNT(*) c FROM ${sqlIdent(ORDER_TABLE)}
              WHERE paymentStatus='PAID' AND status NOT IN ('COMPLETED','REFUND_PENDING')${scoped("id")}`,
        ),
        "payment window masih terbuka": await scalar(
            `SELECT COUNT(*) c FROM ${sqlIdent(ORDER_TABLE)}
              WHERE paymentExpiresAt IS NOT NULL AND paymentExpiresAt > NOW()
                AND paymentStatus IN ('UNPAID','PENDING')${scoped("id")}`,
        ),
        "notifikasi QUEUED/PROCESSING": await scalar(
            `SELECT COUNT(*) c FROM notification WHERE status IN ('QUEUED','PROCESSING')${scoped("orderId")}`,
        ),
        "spinwheelspin terikat order": await scalar(
            `SELECT COUNT(*) c FROM spinwheelspin WHERE orderId IS NOT NULL${scoped("orderId")}`,
        ),
        "chat WhatsApp terikat order": await scalar(
            `SELECT COUNT(*) c FROM whatsapp_chat_state WHERE verifiedOrderId IS NOT NULL${scoped("verifiedOrderId")}`,
        ),
    };

    const recentOrders = await scalar(
        `SELECT COUNT(*) c FROM ${sqlIdent(ORDER_TABLE)}
          WHERE createdAt > (NOW() - INTERVAL 5 MINUTE)${scoped("id")}`,
    );

    const ambiguous: Record<string, number> = {
        "notification tanpa orderId (payload mungkin memuat data order)": notificationUnlinked,
        "adminauditlog entityType=Order": await scalar(
            `SELECT COUNT(*) c FROM adminauditlog WHERE entityType='Order'${scoped("entityId")}`,
        ),
        "voucheruserusage (kuota per-user)": await scalar(
            `SELECT COUNT(*) c FROM voucheruserusage`,
        ),
        "flashsalepurchase (reservasi flash sale)": await scalar(
            `SELECT COUNT(*) c FROM flashsalepurchase`,
        ),
        "spinwheelspin (entitlement user)": await scalar(
            `SELECT COUNT(*) c FROM spinwheelspin`,
        ),
        "whatsapp_chat_state terikat order": (await tableExists("whatsapp_chat_state"))
            ? await scalar(`SELECT COUNT(*) c FROM whatsapp_chat_state WHERE verifiedOrderId IS NOT NULL`)
            : 0,
    };

    return {
        orders,
        maxOrderId,
        recentOrders,
        perDeleteTable,
        preserved,
        notificationUnlinked,
        obligations,
        ambiguous,
    };
}

/* ==========================================================================
 * 8. FINGERPRINT
 * ========================================================================== */

function computeFingerprint(ins: Inspection, counts: Counts): { full: string; short: string } {
    const payload = JSON.stringify({
        db: ins.dbName,
        server: ins.serverVersion,
        scope: scopeLabel(),
        tables: ins.tables.map((t) => t.name).sort(),
        migrations: ins.migrations
            .filter((m) => m.finished && !m.rolledBack)
            .map((m) => m.name)
            .sort(),
        orders: counts.orders,
        maxOrderId: counts.maxOrderId,
    });
    const full = createHash("sha256").update(payload).digest("hex");
    return { full, short: full.slice(0, 16) };
}

/* ==========================================================================
 * 9. VERIFIKASI BACKUP
 * ========================================================================== */

type BackupCheck = { ok: boolean; file: string | null; errors: string[]; details: string[] };

function verifyBackup(file: string | null): BackupCheck {
    const errors: string[] = [];
    const details: string[] = [];
    if (!file) {
        return { ok: false, file: null, errors: ["--backup=<file> wajib untuk --execute"], details };
    }
    const abs = resolve(file);
    if (!existsSync(abs)) {
        return { ok: false, file: abs, errors: ["file backup tidak ditemukan"], details };
    }
    const st = statSync(abs);
    if (!st.isFile() || st.size === 0) errors.push("backup kosong atau bukan file");
    const ageHours = (Date.now() - st.mtimeMs) / 36e5;
    if (ageHours > 24) errors.push(`backup berumur ${ageHours.toFixed(1)} jam (> 24 jam)`);
    details.push(`ukuran=${st.size} byte`, `umur=${ageHours.toFixed(1)} jam`);

    try {
        const fd = readFileSync(abs);
        const gz = fd.length > 2 && fd[0] === 0x1f && fd[1] === 0x8b;
        const sql = fd.subarray(0, 200).toString("utf8").includes("-- MySQL dump");
        if (!gz && !sql) errors.push("isi file bukan dump SQL / gzip");
        details.push(gz ? "format=gzip" : sql ? "format=plain-sql" : "format=tidak dikenali");
    } catch {
        errors.push("file backup tidak bisa dibaca");
    }

    const side = `${abs}.sha256`;
    if (existsSync(side)) {
        try {
            const expected = readFileSync(side, "utf8").trim().split(/\s+/)[0];
            const actual = createHash("sha256").update(readFileSync(abs)).digest("hex");
            if (expected !== actual) errors.push("sha256 tidak cocok dengan file");
            else details.push("sha256=verified");
        } catch {
            errors.push("sidecar sha256 tidak bisa dibaca");
        }
    } else {
        details.push("sha256=sidecar tidak ada");
    }

    return { ok: errors.length === 0, file: abs, errors, details };
}

/* ==========================================================================
 * 10. LAPORAN
 * ========================================================================== */

type Status = "READY" | "BLOCKED";

type Report = {
    tool: "order-cascade-cleanup";
    generatedAt: string;
    mode: "dry-run" | "execute";
    scope: { mode: "all" | "single"; orderId: number | null };
    status: Status;
    environment: {
        db: string;
        server: string;
        hostClass: "local" | "remote" | "unknown";
        foreignKeyChecks: number;
        nodeEnv: string;
    };
    fingerprint: string;
    fingerprintShort: string;
    schema: SchemaValidation;
    dependencyGraph: Array<{
        table: string;
        depth: number;
        parent: string | null;
        column: string | null;
        onDelete: string | null;
        action: "DELETE" | "PRESERVE" | "AMBIGUOUS" | "UNKNOWN";
    }>;
    tables: {
        delete: Array<{ table: string; scopeRows: number; reason: string }>;
        preserve: Array<{ table: string; rows: number }>;
        ambiguous: Array<{ item: string; rows: number }>;
    };
    counts: {
        orders: number;
        totalRowsToDelete: number;
        maxOrderId: number;
    };
    foreignKeyBlockers: Array<{
        child: string;
        parent: string;
        onDelete: string;
        handledBy: string;
    }>;
    obligations: Record<string, number>;
    reasons: string[];
    warnings: string[];
    executeGates: Record<string, { ok: boolean; detail: string }>;
};

function classify(table: string): "DELETE" | "PRESERVE" | "AMBIGUOUS" | "UNKNOWN" {
    if (DELETE_RULES[table]) return "DELETE";
    if (AMBIGUOUS_TABLES.has(table)) return "AMBIGUOUS";
    if (PRESERVE_TABLES.has(table)) return "PRESERVE";
    return "UNKNOWN";
}

function buildReport(
    ins: Inspection,
    graph: GraphNode[],
    schema: SchemaValidation,
    counts: Counts,
    fp: { full: string; short: string },
    mode: "dry-run" | "execute",
    unknownRefs: string[],
): Report {
    const unknown = graph
        .filter((n) => classify(n.table) === "UNKNOWN")
        .map((n) => n.table);

    const deleteTables = graph
        .filter((n) => classify(n.table) === "DELETE")
        .map((n) => ({
            table: n.table,
            scopeRows: counts.perDeleteTable[n.table] ?? 0,
            reason: DELETE_RULES[n.table].reason,
        }))
        .sort((a, b) => (a.table === ORDER_TABLE ? 1 : b.table === ORDER_TABLE ? -1 : a.table.localeCompare(b.table)));

    const reasons: string[] = [];
    const warnings: string[] = [];

    if (!schema.ok) {
        const bits: string[] = [];
        if (schema.missingInDb.length) bits.push(`tabel schema hilang di DB: ${schema.missingInDb.join(", ")}`);
        if (schema.missingMigrations.length)
            bits.push(`migration belum diterapkan: ${schema.missingMigrations.join(", ")}`);
        if (schema.failedMigrations.length)
            bits.push(`migration gagal/rolled-back: ${schema.failedMigrations.join(", ")}`);
        if (schema.requiredColumnsMissing.length)
            bits.push(`kolom wajib hilang: ${schema.requiredColumnsMissing.join(", ")}`);
        reasons.push(`schema drift — ${bits.join("; ")}`);
    }
    if (SCOPE.kind === "single" && counts.orders === 0)
        reasons.push(`order ${SCOPE.orderId} tidak ditemukan`);
    if (unknown.length) reasons.push(`tabel turunan order tidak dikenali: ${unknown.join(", ")}`);
    if (unknownRefs.length)
        reasons.push(
            `kolom referensi order tanpa FK pada tabel tak dikenal: ${unknownRefs.join(", ")}`,
        );
    if (ins.fkChecks !== 1) reasons.push("foreign_key_checks tidak aktif");

    for (const [k, v] of Object.entries(counts.obligations)) {
        if (v > 0) reasons.push(`kewajiban belum direkonsiliasi: ${k} (${v})`);
    }

    if (counts.orders === 0) warnings.push("tidak ada order; tidak ada yang perlu dibersihkan");
    if (schema.extraTables.length)
        warnings.push(`tabel di DB di luar schema.prisma: ${schema.extraTables.join(", ")}`);
    if (counts.notificationUnlinked > 0)
        warnings.push(
            `${counts.notificationUnlinked} notification tanpa orderId dipertahankan (ambigu, cek manual)`,
        );
    if (counts.recentOrders > 0)
        warnings.push(
            `${counts.recentOrders} order dibuat < 5 menit lalu — pastikan checkout & worker sudah berhenti sebelum --execute`,
        );

    const fkBlockers = ins.fks
        .filter((f) => f.parentTable === ORDER_TABLE && /RESTRICT|NO ACTION/i.test(f.onDelete))
        .map((f) => ({
            child: f.childTable,
            parent: f.parentTable,
            onDelete: f.onDelete,
            handledBy: DELETE_RULES[f.childTable]
                ? "dihapus lebih dulu"
                : "TIDAK ditangani — BLOCKED",
        }));

    /*
     * Klasifikasi host dibaca dari environment proses SAJA — bukan dari
     * .env — supaya file credential tidak pernah dibaca oleh tool ini.
     * "unknown" diperlakukan sebagai remote saat eksekusi.
     */
    const hostClass: "local" | "remote" | "unknown" = (() => {
        const raw = (process.env.DATABASE_URL ?? "").trim();
        if (!raw) return "unknown";
        try {
            const host = new URL(raw).hostname;
            return ["localhost", "127.0.0.1", "::1"].includes(host) ? "local" : "remote";
        } catch {
            return "unknown";
        }
    })();

    const confirmGate: Record<string, { ok: boolean; detail: string }> =
        SCOPE.kind === "all"
            ? {
                  "confirm=DELETE-ALL-ORDERS": {
                      ok: ARGS.confirm === "DELETE-ALL-ORDERS",
                      detail:
                          ARGS.confirm === "DELETE-ALL-ORDERS" ? "valid" : "salah/tidak ada",
                  },
              }
            : {
                  "confirm-order=<id>": {
                      ok: ARGS.confirmOrder === String(SCOPE.orderId),
                      detail:
                          ARGS.confirmOrder === null
                              ? "tidak ada"
                              : ARGS.confirmOrder === String(SCOPE.orderId)
                                ? "valid"
                                : "TIDAK cocok",
                  },
              };

    const executeGates = {
        "--execute": { ok: ARGS.execute, detail: ARGS.execute ? "ya" : "belum" },
        ...confirmGate,
        "database-fingerprint": {
            ok: ARGS.fingerprint === fp.full,
            detail: ARGS.fingerprint ? (ARGS.fingerprint === fp.full ? "cocok" : "TIDAK cocok") : "tidak ada",
        },
        backup: { ok: verifyBackup(ARGS.backup).ok, detail: ARGS.backup ?? "tidak ada" },
        "--maintenance-confirmed": { ok: ARGS.maintenance, detail: ARGS.maintenance ? "ya" : "belum" },
        "--writers-stopped": { ok: ARGS.writersStopped, detail: ARGS.writersStopped ? "ya" : "belum" },
        "--mengantar-clear": { ok: ARGS.mengantarClear, detail: ARGS.mengantarClear ? "ya" : "belum" },
        "--obligations-reconciled": {
            ok: ARGS.obligationsReconciled,
            detail: ARGS.obligationsReconciled ? "ya" : "belum",
        },
    };

    const totalRowsToDelete = deleteTables.reduce((s, t) => s + t.scopeRows, 0);

    return {
        tool: "order-cascade-cleanup",
        generatedAt: new Date().toISOString(),
        mode,
        scope: {
            mode: SCOPE.kind,
            orderId: SCOPE.kind === "single" ? SCOPE.orderId : null,
        },
        status: reasons.length ? "BLOCKED" : "READY",
        environment: {
            db: ins.dbName,
            server: ins.serverVersion,
            hostClass,
            foreignKeyChecks: ins.fkChecks,
            nodeEnv: process.env.NODE_ENV ?? "development",
        },
        fingerprint: fp.full,
        fingerprintShort: fp.short,
        schema,
        dependencyGraph: graph.map((n) => ({
            table: n.table,
            depth: n.depth,
            parent: n.edge?.parentTable ?? null,
            column: n.edge?.childColumn ?? null,
            onDelete: n.edge?.onDelete ?? null,
            action: classify(n.table),
        })),
        tables: {
            delete: deleteTables,
            preserve: Object.entries(counts.preserved)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([table, rows]) => ({ table, rows })),
            ambiguous: Object.entries(counts.ambiguous).map(([item, rows]) => ({ item, rows })),
        },
        counts: { orders: counts.orders, totalRowsToDelete, maxOrderId: counts.maxOrderId },
        foreignKeyBlockers: fkBlockers,
        obligations: counts.obligations,
        reasons,
        warnings,
        executeGates,
    };
}

function printHuman(r: Report) {
    const line = (s: string) => process.stdout.write(`${s}\n`);
    line("=".repeat(78));
    line("ORDER CASCADE CLEANUP");
    line("=".repeat(78));
    line(`mode        : ${r.mode}`);
    line(
        `scope       : ${
            r.scope.mode === "all" ? "semua order" : `satu order (id ${r.scope.orderId})`
        }`,
    );
    line(`status      : ${r.status}`);
    line(`database    : ${r.environment.db} (${r.environment.server}, ${r.environment.hostClass})`);
    line(`fingerprint : ${r.fingerprintShort}`);
    line(`orders      : ${r.counts.orders}`);
    line(`rows target : ${r.counts.totalRowsToDelete}`);

    line("\n-- dependency graph (order = root) --");
    for (const n of r.dependencyGraph) {
        const pad = "  ".repeat(n.depth);
        const fk = n.parent ? ` <- ${n.parent}.${n.column} [${n.onDelete}]` : "";
        line(`${pad}${n.table} (${n.action})${fk}`);
    }

    line("\n-- DELETE --");
    for (const t of r.tables.delete) line(`  ${t.table.padEnd(26)} ${String(t.scopeRows).padStart(8)}  ${t.reason}`);

    line("\n-- PRESERVE --");
    for (const t of r.tables.preserve) line(`  ${t.table.padEnd(26)} ${String(t.rows).padStart(8)}`);

    line("\n-- AMBIGUOUS (tidak dihapus, perlu keputusan) --");
    for (const a of r.tables.ambiguous) line(`  ${a.item.padEnd(58)} ${a.rows}`);

    line("\n-- FOREIGN KEY ke order --");
    for (const f of r.foreignKeyBlockers) {
        line(`  ${f.child.padEnd(26)} ON DELETE ${f.onDelete.padEnd(10)} → ${f.handledBy}`);
    }

    line("\n-- KEWAJIBAN --");
    for (const [k, v] of Object.entries(r.obligations)) {
        line(`  ${k.padEnd(46)} ${v}`);
    }

    line("\n-- SCHEMA / MIGRATION --");
    line(`  schema valid        : ${r.schema.ok}`);
    if (r.schema.missingInDb.length) line(`  tabel hilang di DB  : ${r.schema.missingInDb.join(", ")}`);
    if (r.schema.missingMigrations.length)
        line(`  migration tertunda  : ${r.schema.missingMigrations.join(", ")}`);
    if (r.schema.failedMigrations.length)
        line(`  migration gagal     : ${r.schema.failedMigrations.join(", ")}`);
    if (r.schema.extraTables.length) line(`  tabel di luar schema: ${r.schema.extraTables.join(", ")}`);

    if (r.warnings.length) {
        line("\n-- WARNINGS --");
        for (const w of r.warnings) line(`  ! ${w}`);
    }
    if (r.reasons.length) {
        line("\n-- BLOCKERS --");
        for (const x of r.reasons) line(`  x ${x}`);
    }

    if (r.mode === "dry-run") {
        line("\n-- EXECUTE GATES (pratinjau) --");
        for (const [k, v] of Object.entries(r.executeGates)) {
            line(`  ${k.padEnd(32)} ${v.ok ? "OK" : "BELUM"} (${v.detail})`);
        }
        line("\nTidak ada data yang diubah.");
    }
}

/* ==========================================================================
 * 11. EKSEKUSI (dijaga ketat; TIDAK dijalankan pada task ini)
 * ========================================================================== */

async function execute(
    ins: Inspection,
    graph: GraphNode[],
    counts: Counts,
    fp: { full: string; short: string },
    report: Report,
) {
    const gateErrors: string[] = [];
    if (report.status !== "READY") gateErrors.push(...report.reasons);
    for (const [name, g] of Object.entries(report.executeGates)) {
        if (!g.ok) gateErrors.push(`gate gagal: ${name}`);
    }
    /*
     * Flag ini WAJIB untuk setiap eksekusi, bukan hanya DB remote: pada VPS
     * production database justru lokal, sehingga hostClass="local" tidak
     * membuktikan apa pun. Tanpa flag, script tidak boleh menghapus data.
     */
    if (!ARGS.allowProduction) {
        gateErrors.push(
            "--i-understand-production wajib untuk SEMUA --execute " +
                `(db=${report.environment.db}, host=${report.environment.hostClass}, ` +
                `NODE_ENV=${report.environment.nodeEnv})`,
        );
    }
    if (gateErrors.length) {
        process.stderr.write("\nEXECUTE DITOLAK:\n");
        for (const e of gateErrors) process.stderr.write(`  x ${e}\n`);
        process.stderr.write("\nTidak ada data yang dihapus.\n");
        process.exit(2);
    }

    const deleteNodes = graph
        .filter((n) => DELETE_RULES[n.table])
        .sort((a, b) => b.depth - a.depth || (a.table === ORDER_TABLE ? 1 : b.table === ORDER_TABLE ? -1 : a.table.localeCompare(b.table)));

    const orderIds = (
        await ro(
            `SELECT id FROM ${sqlIdent(ORDER_TABLE)} x WHERE ${orderScopeSql("x")} ORDER BY id`,
        )
    ).map((r) => asNum(r.id));

    // Total global sebelum eksekusi, untuk membuktikan mode satu order hanya
    // mengurangi tepat satu baris `order` (tidak menyentuh order lain).
    const totalOrdersBefore = asNum(
        (await ro(`SELECT COUNT(*) c FROM ${sqlIdent(ORDER_TABLE)}`))[0].c,
    );

    const deleted: Record<string, number> = {};
    for (const n of deleteNodes) deleted[n.table] = 0;

    await prisma.$transaction(
        async (tx) => {
            const lock = (await tx.$queryRawUnsafe(
                `SELECT GET_LOCK('mutiara_order_cascade_cleanup', 5) l`,
            )) as Row[];
            if (asNum(lock[0].l) !== 1) throw new Error("gagal memperoleh advisory lock");

            // Fingerprint harus masih sama (tidak ada order baru / migrasi baru).
            const recheckOrders = asNum(
                (await tx.$queryRawUnsafe(
                    `SELECT COUNT(*) c FROM ${sqlIdent(ORDER_TABLE)} x WHERE ${orderScopeSql("x")}`,
                ) as Row[])[0].c,
            );
            const recheckMaxOrderId =
                SCOPE.kind === "single"
                    ? recheckOrders > 0
                        ? SCOPE.orderId
                        : 0
                    : asNum(
                          (await tx.$queryRawUnsafe(
                              `SELECT COALESCE(MAX(id),0) m FROM ${sqlIdent(ORDER_TABLE)}`,
                          ) as Row[])[0].m,
                      );
            const recheck = computeFingerprint(ins, {
                ...counts,
                orders: recheckOrders,
                maxOrderId: recheckMaxOrderId,
            });
            if (recheck.full !== fp.full) {
                throw new Error("fingerprint berubah saat eksekusi — abort");
            }

            for (let i = 0; i < orderIds.length; i += ARGS.batch) {
                const chunk = orderIds.slice(i, i + ARGS.batch).join(",");

                for (const n of deleteNodes) {
                    if (n.table === ORDER_TABLE) continue;
                    const where = DELETE_RULES[n.table].predicate("x");
                    const res = await tx.$executeRawUnsafe(
                        `DELETE FROM ${sqlIdent(n.table)} WHERE ${where.replace(/\bx\./g, "")} AND orderId IN (${chunk})`,
                    );
                    deleted[n.table] += Number(res);
                }
            }

            const orderRes = await tx.$executeRawUnsafe(
                `DELETE FROM ${sqlIdent(ORDER_TABLE)} WHERE id IN (${orderIds.join(",") || "NULL"})`,
            );
            deleted[ORDER_TABLE] = Number(orderRes);

            // Post-check di dalam transaksi.
            const left = asNum(
                (await tx.$queryRawUnsafe(
                    `SELECT COUNT(*) c FROM ${sqlIdent(ORDER_TABLE)} x WHERE ${orderScopeSql("x")}`,
                ) as Row[])[0].c,
            );
            if (left !== 0) throw new Error(`post-check: masih ada ${left} order`);

            if (SCOPE.kind === "single") {
                const totalAfter = asNum(
                    (await tx.$queryRawUnsafe(
                        `SELECT COUNT(*) c FROM ${sqlIdent(ORDER_TABLE)}`,
                    ) as Row[])[0].c,
                );
                if (totalAfter !== totalOrdersBefore - 1) {
                    throw new Error(
                        `post-check: jumlah order ${totalOrdersBefore} → ${totalAfter}, ` +
                            `seharusnya ${totalOrdersBefore - 1}`,
                    );
                }
            }

            for (const n of deleteNodes) {
                if (n.table === ORDER_TABLE) continue;
                const where = DELETE_RULES[n.table].predicate("x");
                const remain = asNum(
                    (await tx.$queryRawUnsafe(
                        `SELECT COUNT(*) c FROM ${sqlIdent(n.table)} x WHERE ${where} AND ${scopeSql("x")}`,
                    ) as Row[])[0].c,
                );
                if (remain !== 0) throw new Error(`post-check: ${n.table} menyisakan ${remain} baris`);
            }

            for (const [t, before] of Object.entries(counts.preserved)) {
                if (!(await tableExists(t))) continue;
                const after = asNum(
                    (await tx.$queryRawUnsafe(
                        `SELECT COUNT(*) c FROM ${sqlIdent(t)}`,
                    ) as Row[])[0].c,
                );
                if (after !== before) {
                    throw new Error(`master-data drift pada ${t}: ${before} → ${after}`);
                }
            }

            await tx.$queryRawUnsafe(`SELECT RELEASE_LOCK('mutiara_order_cascade_cleanup')`);
        },
        { timeout: 15 * 60 * 1000, maxWait: 30_000 },
    );

    process.stdout.write("\nEKSEKUSI SELESAI. Ringkasan baris terhapus:\n");
    for (const [t, c] of Object.entries(deleted)) {
        process.stdout.write(`  ${t.padEnd(26)} ${c}\n`);
    }
    process.stdout.write("Master data diverifikasi tidak berubah.\n");
    process.stdout.write("Tidak ada panggilan ke Mengantar / WhatsApp / payment gateway.\n");
}

/* ==========================================================================
 * 12. MAIN
 * ========================================================================== */

async function main() {
    const ins = await inspect();
    if (ins.tables.some((t) => t.engine !== "InnoDB" && t.name !== "_prisma_migrations")) {
        // Transaksi hanya aman untuk InnoDB.
        process.stderr.write("ERROR: ada tabel non-InnoDB; transaksi tidak aman.\n");
        process.exit(2);
    }

    const graphInfo = buildGraph(ins);
    const schema = validateSchema(ins);
    const counts = await collectCounts(graphInfo.nodes);
    const fp = computeFingerprint(ins, counts);
    const mode: "dry-run" | "execute" = ARGS.execute ? "execute" : "dry-run";

    const report = buildReport(
        ins,
        graphInfo.nodes,
        schema,
        counts,
        fp,
        mode,
        graphInfo.unknown,
    );

    if (ARGS.reportJson) {
        const json = JSON.stringify(report, null, 2);
        if (ARGS.reportJson === true) {
            process.stdout.write(`${json}\n`);
        } else {
            writeFileSync(resolve(String(ARGS.reportJson)), `${json}\n`, "utf-8");
            printHuman(report);
            process.stdout.write(`\nJSON report: ${ARGS.reportJson}\n`);
        }
    } else {
        printHuman(report);
    }

    if (ARGS.execute) {
        await execute(ins, graphInfo.nodes, counts, fp, report);
        return;
    }

    process.exit(report.status === "READY" ? 0 : 2);
}

main()
    .catch(async (e) => {
        process.stderr.write(`\nFATAL: ${e?.message ?? e}\n`);
        await prisma.$disconnect();
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
