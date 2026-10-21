# FINAL RESET & VPS DEPLOYMENT READINESS

**Project:** marketplate-mutiaraabadi
**Tanggal pemeriksaan:** 19 Oktober 2026 (Asia/Jakarta)
**Target DB yang diperiksa:** `toko` @ `127.0.0.1:3306` (host `webdev`, MariaDB 11.8.8)
**Production:** tidak disentuh. Tidak ada cleanup, migration, atau deployment yang dijalankan ke production.

## Status

| Area | Status |
|---|---|
| **LOCAL RESET** | **BLOCKED** — target `Order = 0` tidak tercapai; 50 order masih tersimpan karena kewajiban finansial/pengiriman belum selesai |
| **VPS DEPLOYMENT** | **NOT READY** — ada blocker keras: kode belum di-commit, `deploy.sh` tidak ada, nginx/PM2 belum dikonfigurasi, env produksi belum aman. Perubahan WhatsApp menambah default session path persisten dan config PM2 satu instance; kondisi VPS tetap belum diverifikasi. |

Tidak ada `DELETE`, `UPDATE`, `ALTER`, `DROP`, atau `TRUNCATE` yang dijalankan pada database aplikasi dalam sesi ini. Satu-satunya DDL adalah pembuatan/penghapusan database disposable untuk uji restore.

---

# TASK A — FULL LOCAL ORDER RESET

## A.1 Verifikasi target database

| Bukti | Nilai |
|---|---|
| `DATABASE_URL` (host/port/db) | `127.0.0.1:3306` / `toko` |
| `SELECT DATABASE()` | `toko` |
| `@@hostname` | `webdev` |
| Versi server | MariaDB 11.8.8 |
| Foreign key aktif | 56 constraint, `foreign_key_checks = 1` |
| Assertion script | `phase-2-cleanup.ts` menolak host selain `127.0.0.1`/`localhost`/`::1` dan DB selain `toko` |

Target dipastikan **lokal**, bukan production.

## A.2 Kondisi awal dan akhir sesi ini

Tidak ada reset yang dijalankan, sehingga angka sebelum dan sesudah identik.

| Tabel | Sebelum | Sesudah | Delta |
|---|---:|---:|---:|
| `order` | 50 | 50 | 0 |
| `orderitem` | 36 | 36 | 0 |
| `refund` | 2 | 2 | 0 |
| `affiliateconversion` | 17 | 17 | 0 |
| `notification` (terkait order) | 17 | 17 | 0 |
| `guestrecoverychallenge` | 0 | 0 | 0 |
| `shipmentjob` | 0 | 0 | 0 |

**Target akhir yang diminta:** `Order = 0`, `OrderItem = 0`, `Refund = 0`, `AffiliateConversion = 0`, `Notification terkait Order = 0` — **tidak tercapai**.

Konteks kumulatif: sesi cleanup sebelumnya menghapus 113 order yang terbukti aman (163 → 50). Sesi ini tidak menghapus apa pun karena tidak ada order yang aman dan kewajiban belum selesai.

## A.3 Preservation baseline (utuh, tidak berubah)

| Data | Nilai |
|---|---:|
| User | 402 |
| AffiliateProfile | 15 |
| AffiliatePayout | 5 (total Rp 151.450) |
| Product | 28 (total `sold` 100) |
| ProductVariant | 8 (total stok 2.085) |
| Voucher | 2 (`usedCount` total 1) |
| ShippingDiscount | 6 (`usedCount` total 144) |
| SpinWheelSpin | 13 |
| AdminAuditLog | 875 |
| VoucherUserUsage | 1 |
| FlashSalePurchase | 0 |
| File bukti / upload | tidak disentuh |

Dibandingkan dengan snapshot `preservation-snapshot.json` dari sesi sebelumnya: **identik**. Tidak ada restock, perubahan counter, perubahan payout, atau perubahan audit log.

## A.4 Penghalang aktual (bukan asumsi)

### 1. Refund terbuka — 2 record, Rp 93.500

| Refund | Order | Nominal | Status | Provider ref / bukti |
|---|---|---:|---|---|
| #6 | 87 (`PAY-CART-1787197293862-7018`) | Rp 34.000 | `PROCESSING` | kosong |
| #8 | 783 (`PAY-BN-1788139737285-b1dce979`) | Rp 59.500 | `PENDING` | kosong |

Dana refund belum terbukti ditransfer. Menandai `COMPLETED`/`FAILED` tanpa bukti nyata = memalsukan status finansial.

### 2. Payout affiliate terbuka — 4 record, Rp 148.450

| Payout | Affiliate | Nominal | Status | Catatan |
|---|---|---:|---|---|
| #107 | 227 | Rp 8.000 | `PENDING` | rekening "Test" / 1234567890 |
| #108 | 228 | Rp 3.000 | `PENDING` | rekening "Test" / 1234567890 |
| #117 | 1 | Rp 52.450 | `PROCESSING` | Seabank |
| #173 | 1 | Rp 85.000 | `PENDING` | Seabank |

(#109, Rp 3.000, sudah `REJECTED`.)

Tidak ada `providerTransactionId`, `prov. reference`, `paidAt`, atau bukti transfer pada keempatnya. Status tidak boleh diubah sepihak.

### 3. Conversion / komisi — 17 baris, 10 belum settled

11 order diblokir karena `conversion_liability`: conversion berstatus `PENDING`/`APPROVED`, atau terikat affiliate yang masih punya payout terbuka.

### 4. COD belum selesai — 18 order

Order `paymentMethod = COD` dengan status selain `CANCELLED`/`COMPLETED`. Tidak ada bukti barang diterima/dibayar.

### 5. Resi / tracking — 11 order

Terdapat `trackingNumber` (contoh `JY1306326994`, `AKX23859`, `228339`). `providerShipmentId` = 0 (alur lama/RajaOngkir), sehingga status pengiriman tidak dapat diverifikasi otomatis dari sini. Menghapusnya akan menghilangkan bukti pengiriman nyata.

### 6. Pembayaran online belum terverifikasi — 20 order

Order non-COD dengan `paymentStatus UNPAID/PENDING` dan tanpa/`> NOW()` expiry, termasuk order uji `TEST-...` dan `VERIFY-...`. Tidak boleh dihapus tanpa bukti transaksi ditutup.

### 7. Tabel WhatsApp belum ada

`whatsapp_chat_state` dan `whatsapp_inbound_message` belum dibuat di DB lokal (migration `20261013120000_whatsapp_autoreply_state` masih pending). Ini juga menjadi blocker gate `scope=all`.

### Ringkasan gate

```
scope=all  → BLOCKED  (exit 2)
  refund_open=2
  payout_open=4
  open_cod=18
  tracking_unverified=11
  whatsapp_tables_missing
scope=safe → NOTHING_SAFE_TO_DELETE (exit 0)
  50 blocked orders, 0 safe orders
```

Keputusan: **reset penuh tidak dijalankan**. Memaksa `Order = 0` berarti mengubah status refund/payout/COD/pengiriman atau melewati gate — keduanya dilarang oleh instruksi.

## A.4b Relasi yang bergantung pada `order`

Dari `information_schema.KEY_COLUMN_USAGE`, hanya 7 tabel yang memiliki FK ke `order`:

| Tabel | Kolom | Perilaku | Isi sekarang |
|---|---|---|---:|
| `orderitem` | `orderId` | `RESTRICT` | 36 |
| `refund` | `orderId` | `RESTRICT` | 2 |
| `affiliateconversion` | `orderId` | `RESTRICT` | 17 |
| `notification` | `orderId` | `SET NULL` | 17 |
| `guestrecoverychallenge` | `orderId` | `CASCADE` | 0 |
| `shipmentjob` | `orderId` | `CASCADE` | 0 |
| `spinwheelspin` | `orderId` | `SET NULL` | 13 total, **0 terhubung ke order** |

Tidak ada tabel lain yang mereferensikan `refund`, `affiliateconversion`, `notification`, `shipmentjob`, `guestrecoverychallenge`, atau `affiliatepayout`. Karena `spinwheelspin.orderId` seluruhnya `NULL`, penghapusan order tidak akan mengubah satu pun baris SpinWheelSpin.

## A.5 AffiliatePayout — foreign key dan ketergantungan

**Struktur (aman):**

| Arah | Constraint |
|---|---|
| Dari `affiliatepayout` | Hanya `affiliateId → affiliateprofile.id` (`RESTRICT`) |
| Ke `affiliatepayout` | Tidak ada tabel lain yang mereferensikan `affiliatepayout` |

`AffiliatePayout` **tidak memiliki FK** ke `order`, `refund`, maupun `affiliateconversion`. Secara skema, menghapus conversion tidak melanggar FK.

**Ketergantungan logis (tidak aman):**

`getAvailableBalance()` menghitung:

```
earned    = SUM(commissionAmount) WHERE status IN ('APPROVED','PAID')
disbursed = SUM(amount)           WHERE status IN ('PENDING','PROCESSING','PAID')
available = max(0, earned - disbursed)
```

| Affiliate | Earned | Disbursed | Payout terbuka | Available |
|---|---:|---:|---:|---:|
| 1 | Rp 137.450 | Rp 137.450 | 2 | Rp 0 |
| 227 | Rp 10.000 | Rp 8.000 | 1 | Rp 2.000 |
| 228 | Rp 0 | Rp 3.000 | 1 | Rp 0 (sudah negatif) |

Menghapus seluruh conversion akan membuat 4 payout terbuka (Rp 148.450) **tanpa ledger komisi yang menjadi dasarnya**; rumus `max(0, …)` menyembunyikan selisihnya, bukan menyelesaikannya. Karena itu conversion tidak dihapus.

## A.6 Backup terbaru + uji restore

| Item | Nilai |
|---|---|
| File | `/home/reksa/order-cleanup-backups/toko-2026-10-19T04-33-55-681Z.sql.gz` |
| Ukuran | 107.067 byte |
| SHA-256 | `635d73c26d5d932e79df9de346189222741329d648fa3e9274c34fcf6bed8d55` |
| Metode | `mysqldump --single-transaction --quick --routines --triggers` |
| Uji restore | database disposable `toko_restore_verify_*` |
| Tabel | 45/45 cocok, 0 hilang, 0 ekstra |
| Row count | 0 mismatch pada 45 tabel |
| Foreign key | 56 → 56, `foreign_key_checks = 1` |
| Status | `RESTORE_VERIFIED` |
| Cleanup | database uji di-drop (`remaining = 0`) |

Backup sebelumnya (pre-delete 113 order) tetap tersimpan: `toko-2026-10-19T04-23-54-025Z.sql.gz` (SHA-256 `bdccfb50…870f55`).

## A.7 Arsip transaksi

Direktori: `/home/reksa/order-cleanup-archives/final-reset-2026-10-19T04-33-18-394Z/` (mode `0700`, file `0600`)

| File | Isi | Baris data |
|---|---|---:|
| `audit.json` | identitas DB, counts, blocker, preservation, orphan, dependency payout | — |
| `remaining-orders.csv` | 50 order + status, nominal, payment reference, paymentNo, expiry, resi, COD, alasan blokir | 50 |
| `orderitems.csv` | seluruh order item yang akan dihapus | 36 |
| `refunds.csv` | 2 refund + nominal/status/bukti | 2 |
| `affiliate-conversions.csv` | 17 conversion + komisi/status | 17 |
| `affiliate-payouts.csv` | 5 payout (termasuk rekening & provider ref) | 5 |
| `notifications.csv` | 17 notifikasi terkait order | 17 |
| `foreign-keys.json` | FK payout + dependen | — |

Orphan check: `orderitem 0`, `refund 0`, `affiliateconversion 0`, `notification 0`, `guestrecoverychallenge 0`, `shipmentjob 0`.

## A.8 Mekanisme reset yang tersedia (tidak dijalankan)

`scripts/order-cleanup/phase-2-cleanup.ts` sudah memiliki:

- Target assertion lokal + DB `toko`.
- Gate backup (gzip, ukuran), archive dir, fingerprint dry-run.
- Re-check blocker **di dalam transaksi** sebelum `DELETE`.
- Satu transaksi InnoDB; rollback jika post-check gagal.
- Larangan menonaktifkan FK, tanpa TRUNCATE/DROP, tanpa perubahan stok/counter/payout/audit.
- Idempotensi (`ALREADY_CLEAN`/`NOTHING_SAFE_TO_DELETE`).
- Preservation snapshot sebelum/sesudah.

Perintah yang **baru boleh** dijalankan setelah semua blocker selesai:

```bash
# 1. dry-run, simpan fingerprint
npx tsx --env-file=.env scripts/order-cleanup/phase-2-cleanup.ts --scope=all

# 2. backup baru + uji restore (wajib)
#    (gunakan prosedur di A.6)

# 3. arsip
mkdir -p /home/reksa/order-cleanup-archives/reset-$(date -u +%Y%m%dT%H%M%SZ)

# 4. eksekusi — hanya jika dry-run READY dan token eksternal benar
npx tsx --env-file=.env scripts/order-cleanup/phase-2-cleanup.ts \
  --scope=all --execute \
  --confirm=DELETE-ALL-ORDER-HISTORY \
  --backup=/path/toko-....sql.gz \
  --archive=/path/arsip \
  --fingerprint=<dari dry-run> \
  --external-verified=NO_ACTIVE_SHIPMENTS
```

`--external-verified=NO_ACTIVE_SHIPMENTS` hanya boleh dipakai setelah resi/COD benar-benar diverifikasi di Mengantar. Token ini tidak dipakai pada sesi ini.

## A.9 Yang harus diselesaikan pemilik untuk membuka reset

1. **Refund #6 dan #8** — transfer nyata dengan bukti, atau penolakan terdokumentasi lewat alur admin.
2. **Payout #107, #108, #117, #173** — transfer bank nyata atau reject/cancel lewat alur admin. Jangan edit DB.
3. **18 COD** — selesaikan pengiriman/pembayaran atau batalkan dengan bukti; **11 resi** diverifikasi di Mengantar.
4. **20 pembayaran online** — tutup/expire/cancel sesuai status nyata.
5. **Migration WhatsApp** — buat tabel setelah backup.
6. Jalankan ulang dry-run sampai `READY`, lalu eksekusi dengan gate di A.8.

---

# TASK B — VPS DEPLOYMENT READINESS

## B.1 Ringkasan verdict: **NOT READY**

Build dan test lulus, tetapi itu **tidak cukup**. Ada blocker yang membuat deploy gagal atau berbahaya secara finansial/keamanan.

## B.2 Git working tree

| Item | Nilai |
|---|---|
| Branch | `main` |
| HEAD | `099f9af` — "fix order delete" (2026-10-19 10:38 +07) |
| Remote | `git@github.com:Reksa776/marketplate-mutiaraabadi.git` |
| Modified | `app/api/payment/ipaymu/notification/route.ts`, `app/api/payment/midtrans/notification/route.ts`, `lib/admin/audit-log.ts` |
| Untracked | `lib/payment/webhook-trace.ts`, `__tests__/security/payment-webhook-orphan-trace.test.ts`, `scripts/order-cleanup/`, `docs/order-cleanup/` |

**Blocker:** workflow deploy berjalan dari `git push` ke `main`, tetapi perubahan di atas belum di-commit/push. Deploy sekarang akan mengirim kode lama (tanpa audit trail webhook orphan).

## B.3 Production build

| Item | Hasil |
|---|---|
| Perintah | `npm run build` (`prebuild`: `prisma generate`) |
| Exit | **0 (PASS)** |
| Framework | Next.js 16.3.0 (App Router, Turbopack) |
| Node | v24.21.0, npm 10.9.9 |
| Output | semua route ter-compile, termasuk `/api/payment/ipaymu/notification` dan `/api/payment/midtrans/notification` |
| `.next` | 784 MB |
| `output: standalone` | tidak dipakai |

Build lokal menggunakan `.env.local` (lihat B.5), jadi hasil build meng-inline `NEXT_PUBLIC_APP_URL=http://localhost:3002`. Build di VPS harus dilakukan **setelah** env produksi benar.

## B.4 Prisma schema & migration

| Item | Hasil |
|---|---|
| `prisma validate` | PASS |
| Migration dir | 29 (termasuk `0_baseline`) — 28 applied + 1 pending |
| Pending | `20261013120000_whatsapp_autoreply_state` (additive: 2 tabel baru) |
| `prisma migrate status` | exit 1 — "Following migration have not yet been applied" |
| Diff DB → schema | tidak ada `DROP TABLE`/`DROP COLUMN`; hanya 2 tabel WhatsApp + redefinisi FK/index (cosmetic) |

Riwayat `_prisma_migrations` (lokal):

- 29 baris: 28 finished (`0_baseline` + 27 migration lain) + 1 baris `20260922020000_add_tiktok_pixel_enabled` yang pernah gagal lalu `rolled_back`, kemudian berhasil diterapkan ulang (karena itu nama tersebut muncul dua kali).
- `0_baseline` **ada** di repo (`prisma/migrations/0_baseline/migration.sql`, 389 baris) dan sudah tercatat applied di DB lokal.

**Risiko production:** status migrasi production belum diketahui. `prisma migrate deploy` pada DB yang tabelnya sudah ada tetapi `_prisma_migrations`-nya kosong akan mencoba membuat ulang tabel dan gagal. Jangan jalankan `migrate deploy` ke production sebelum:

1. Backup production.
2. `npx prisma migrate status` di production (read-only).
3. Jika riwayat tidak cocok → `prisma migrate resolve --applied <migration>` yang sesuai, bukan `deploy` buta.

Migration yang pending bersifat additive (2 tabel baru, tanpa FK), jadi aman diterapkan setelah backup.

## B.5 Environment variables

### Konflik `.env` vs `.env.local` (lokal)

`.env.local` menimpa `.env` di **semua** environment Next.js, termasuk `next build`/`next start`:

```
PAYMENT_ENVIRONMENT=sandbox
IPAYMU_IS_PRODUCTION=false
NEXT_PUBLIC_APP_URL=http://localhost:3002
```

Akibatnya checkout lokal memakai sandbox, meskipun `.env` berisi `PAYMENT_ENVIRONMENT=production`.

Dengan `.env` saja (kondisi yang akan dipakai jika file ini disalin ke VPS), resolver iPaymu **gagal**:

```
iPaymu configuration invalid: NEXT_PUBLIC_APP_URL must not reference localhost/sandbox in production
```

`NEXT_PUBLIC_APP_URL` juga menjadi `notifyUrl` iPaymu:

```
${appUrl}/api/payment/ipaymu/notification
```

Jadi `NEXT_PUBLIC_APP_URL` **wajib** `https://<domain>` sebelum build/deploy. Nilai ini di-inline saat build untuk client.

### Kelengkapan env

`.env` lokal berisi kredensial iPaymu production, Cloudinary, Mengantar, Midtrans, AUTH_SECRET, CRON_SECRET, RajaOngkir, WhatsApp. Yang **tidak ada** di `.env`:

- `PAYOUT_API_KEY`, `PAYOUT_SECRET_KEY`, `PAYOUT_MERCHANT_ID`, `PAYOUT_BASE_URL`
- `MAIL_FROM`, `SMTP_*`
- `REDIS_URL`
- `TRUSTED_PROXY`, `TRUSTED_PROXY_HOPS`
- `UPLOAD_DIR`
- `MENGANTAR_BASE_URL` (`.env.example` mencantumkan, kode tidak membacanya)
- `IPAYMU_QRIS_CHANNEL`, `WHATSAPP_INTERACTIVE_BUTTONS`

**Kritis:** `lib/affiliate/payout-provider.ts` masuk **DEVELOPMENT MODE** jika `PAYOUT_API_KEY`/`PAYOUT_SECRET_KEY` kosong — disbursement disimulasikan `SUCCESS` dan payout bisa ditandai `PAID` tanpa transfer nyata. Di production, empat payout terbuka (Rp 148.450) tidak boleh diproses sebelum kredensial payout diisi.

`.env.example` juga belum mendokumentasikan `MIDTRANS_SERVER_KEY`, `MIDTRANS_CLIENT_KEY`, `MIDTRANS_IS_PRODUCTION`, `NEXT_PUBLIC_MIDTRANS_*` (dipakai route Midtrans). Tanpa `MIDTRANS_SERVER_KEY`, webhook Midtrans gagal-closed (401).

`AUTH_SECRET` (64 char) ada di `.env`; wajib ada di VPS untuk NextAuth dan `guestIdentityKey` (fallback `GUEST_IDENTITY_PEPPER`).

### Env minimum untuk VPS

```
DATABASE_URL=mysql://<user>:<pass>@127.0.0.1:3306/<db>
AUTH_SECRET=<32+ byte secret>
NEXT_PUBLIC_APP_URL=https://<domain>
PAYMENT_ENVIRONMENT=production
IPAYMU_PRODUCTION_VA=...
IPAYMU_PRODUCTION_API_KEY=...
IPAYMU_PRODUCTION_BASE_URL=https://my.ipaymu.com
MENGANTAR_API_KEY=...
MENGANTAR_WEBHOOK_SECRET=...
CRON_SECRET=...
PAYOUT_API_KEY=...            # tanpa ini payout disimulasikan
PAYOUT_SECRET_KEY=...
PAYOUT_MERCHANT_ID=...
PAYOUT_BASE_URL=https://api.midtrans.com
UPLOAD_DIR=/var/lib/marketplate/uploads
WHATSAPP_AUTH_DIR=/var/lib/marketplate/whatsapp-auth
TRUSTED_PROXY=1
TRUSTED_PROXY_HOPS=1
NOTIFICATION_PROVIDER=whatsapp
# opsional: SMTP_*, CLOUDINARY_*, RAJAONGKIR_*, MIDTRANS_*
```

Jangan menyalin `.env.local` ke VPS.

## B.6 Webhook iPaymu & Midtrans

| Provider | Endpoint | Verifikasi | Kebutuhan |
|---|---|---|---|
| iPaymu | `/api/payment/ipaymu/notification` | `X-Signature` (HMAC) + VA, timing-safe; 401 jika gagal | `IPAYMU_PRODUCTION_VA`, API key, URL publik HTTPS |
| Midtrans | `/api/payment/midtrans/notification` | `signature_key` = SHA-512(`order_id`+`status_code`+`gross_amount`+`serverKey`) | `MIDTRANS_SERVER_KEY`, URL publik HTTPS |
| Payout | `/api/payment/payout/webhook` | kredensial payout | `PAYOUT_*` + URL publik |

Webhook tidak bisa diverifikasi end-to-end dari mesin ini. `NEXT_PUBLIC_APP_URL` lokal (`localhost`) membuat `notifyUrl` tidak dapat dijangkau iPaymu → pembayaran production akan gagal dibuat. Tidak ada pemanggilan API eksternal dalam audit ini.

## B.7 WhatsApp

| Item | Status |
|---|---|
| Migration `whatsapp_autoreply_state` | **pending** — tabel belum ada |
| `data/whatsapp-auth` | **tidak ada** di disk |
| `WHATSAPP_AUTH_DIR` | default production kini `/var/lib/marketplate/whatsapp-auth`; dev tetap `data/whatsapp-auth`. Sesi lama tidak dipindahkan otomatis. |
| Proses | Baileys berjalan in-process lewat `instrumentation.ts` |
| Single instance | bootstrap menolak/melewati instance PM2 cluster; harus 1 proses |

**Blocker:** bot tidak bisa start tanpa tabel + direktori sesi persisten. Sesi WhatsApp juga tidak boleh ikut terhapus saat deploy (simpan di luar repo, backup).

## B.8 PM2

| Item | Status |
|---|---|
| `pm2` terpasang | **tidak** (tidak ada di PATH / `~/.pm2`) |
| `ecosystem.config.*` | kini tersedia sebagai `ecosystem.config.cjs` (fork, 1 instance); PM2 di VPS tetap belum diverifikasi |
| Script start | `next start -p 3002` (bind semua interface) |
| Proses aplikasi | tidak berjalan (port 3002 tertutup) |

**Blocker:** tidak ada process manager/konfigurasi. Untuk Baileys gunakan **fork mode, instances=1** (bukan cluster). Alternatif: systemd unit.

## B.9 Nginx & domain

| Item | Status |
|---|---|
| Nginx | aktif (1.30.4) |
| Server block | hanya default: `listen 80`, `server_name _`, `root /usr/share/nginx/html` |
| Proxy ke 3002 | **tidak ada** |
| TLS/443 | **tidak ada** (blok HTTPS masih dikomentari) |
| `client_max_body_size` | tidak diset (default 1 MB) — upload bukti PDF/gambar bisa gagal |
| Port 3002 | tidak listening |

Domain yang disebut di `next.config.ts` (`allowedDevOrigins`): `mutiaraabadisnack.com`, `demosolusisejalan.my.id`. Domain produksi final belum dikonfirmasi.

**Blocker:** belum ada reverse proxy/TLS. Port aplikasi sebaiknya di-bind ke `127.0.0.1` (`next start -H 127.0.0.1 -p 3002`) agar tidak bisa diakses langsung.

Contoh konfigurasi yang perlu dibuat di VPS (belum diterapkan):

```nginx
server {
    listen 80;
    server_name <domain>;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name <domain>;

    ssl_certificate     /etc/letsencrypt/live/<domain>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<domain>/privkey.pem;

    client_max_body_size 15m;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $remote_addr;
    }
}
```

## B.10 CI/CD

`.github/workflows/deploy.yml` (push ke `main`) menjalankan SSH ke VPS lalu:

```bash
cd ~/demo-marketplace
./deploy.sh
```

**Blocker keras:** `deploy.sh` **tidak ada** di repository (`git ls-files` kosong). Dengan `set -e`, deploy berhenti di situ. Workflow juga memakai `nvm use 24`; Node 24 tersedia di mesin ini, belum diverifikasi di VPS.

Secret yang dibutuhkan workflow: `VPSBIZNET`, `VPS_NAME`, `VPS_SSH_KEY` — tidak dapat diverifikasi dari sini.

## B.11 Risiko database production

- Production tidak diakses dan tidak diubah.
- Cleanup order **tidak boleh** dijalankan di production.
- Riwayat migrasi production tidak diketahui; lihat B.4.
- Backup production wajib sebelum `migrate deploy`.
- Perbedaan versi DB tidak diketahui (lokal MariaDB 11.8.8; Prisma `mysql`). `binaryTargets` sudah mencakup `debian-openssl-3.0.x`, tetapi OS VPS belum diverifikasi.
- `prisma migrate deploy` hanya menerapkan migration pending (additive), bukan reset.

## B.12 File upload & data sensitif

| Item | Nilai |
|---|---|
| `storage/uploads` | 668 KB |
| File terlacak git | 14, termasuk **5 foto KTP affiliate** |
| `storage/` di `.gitignore` | **tidak** |
| Upload runtime | ditulis ke `<cwd>/storage/uploads` kecuali `UPLOAD_DIR` diset |

**Risiko:**
1. PII (KTP) tersimpan di repository git.
2. File upload runtime muncul sebagai untracked; `git reset --hard`/clone ulang akan menghapusnya.
3. Deploy berbasis `git pull` dapat bentrok dengan file upload.

**Rekomendasi:** set `UPLOAD_DIR=/var/lib/marketplate/uploads`, pindahkan file lama, tambahkan `storage/uploads/` ke `.gitignore`, dan backup direktori tersebut.

## B.13 Cron / shipment reconcile

`GET|POST /api/cron/shipment-reconcile` membutuhkan `CRON_SECRET`, tetapi tidak ada cron systemd/user/crontab yang memanggilnya. Tanpa scheduler, rekonsiliasi pengiriman tidak berjalan otomatis.

## B.14 Pengujian yang dijalankan

| Pemeriksaan | Hasil |
|---|---|
| `npm run build` | PASS (exit 0) |
| `prisma validate` | PASS |
| `prisma migrate status` | exit 1 — 1 migration pending (by design) |
| `prisma migrate diff` (DB→schema) | tanpa DROP; 2 tabel baru |
| Jest | **103 suite, 2478 passed, 4 skipped, 0 failed** (29,7 s) |
| `npm ls --depth=0` | exit 0 |
| Restore backup | 45/45 tabel, 56 FK, 0 mismatch |
| Dry-run cleanup `all` | BLOCKED (exit 2) |
| Dry-run cleanup `safe` | NOTHING_SAFE_TO_DELETE (exit 0) |

Tidak ada perubahan kode aplikasi dalam sesi ini, sehingga `tsc --noEmit` tidak diulang (terakhir PASS pada kode yang sama).

## B.15 Checklist kesiapan

| # | Item | Status |
|---|---|---|
| 1 | Working tree bersih & ter-push | **FAIL** — 3 modified + 4 untracked |
| 2 | Production build | PASS |
| 3 | Prisma schema valid | PASS |
| 4 | Migration production aman/terverifikasi | **FAIL** — riwayat prod belum diketahui; 1 pending |
| 5 | Env produksi lengkap & benar | **FAIL** — `NEXT_PUBLIC_APP_URL` localhost, `.env.local` sandbox, `PAYOUT_*` kosong |
| 6 | Webhook iPaymu siap | **FAIL** — butuh URL HTTPS publik |
| 7 | Webhook Midtrans siap | **FAIL** — kunci tidak terdokumentasi; URL belum publik |
| 8 | WhatsApp siap | **FAIL** — tabel & auth dir belum ada |
| 9 | PM2/process manager | **FAIL** — tidak terpasang, tanpa config |
| 10 | Nginx + TLS + domain | **FAIL** — hanya default server |
| 11 | `deploy.sh` untuk CI | **FAIL** — file tidak ada; workflow kini fail-fast sebelum mencoba deploy |
| 12 | Cron rekonsiliasi | **FAIL** — tanpa scheduler |
| 13 | Upload persisten & aman | **FAIL** — di dalam repo, PII ter-track |
| 14 | Backup production | belum dilakukan (tidak diakses) |

## B.16 Perintah deployment (kondisional — belum dijalankan)

Setelah blocker B.2–B.13 diselesaikan, urutan yang sesuai konfigurasi project:

```bash
# di VPS
cd ~/demo-marketplace
git pull --ff-only
npm ci
npx prisma migrate status          # harus menunjukkan hanya migration yang dikenal
npx prisma migrate deploy          # additive; backup DB lebih dulu
npm run build                      # NEXT_PUBLIC_APP_URL harus sudah https
pm2 start npm --name marketplate -- start   # fork mode, instances = 1
pm2 save
```

`pm2 start npm -- start` menjalankan `next start -p 3002`. Untuk topologi nginx, bind ke loopback (jangan menambah argumen setelah `npm -- start`, karena script sudah membawa `-p 3002`):

```bash
pm2 start node_modules/next/dist/bin/next --name marketplate -- start -H 127.0.0.1 -p 3002
```

Jangan menjalankan perintah di atas sebelum `deploy.sh`, env, nginx/TLS, dan backup production siap.

---

## Kesimpulan

- **LOCAL RESET: BLOCKED.** 50 order, 2 refund (Rp 93.500), 4 payout (Rp 148.450), 18 COD, 11 resi, dan 20 pembayaran online belum terselesaikan. Tidak ada data yang dihapus/diubah, tidak ada status yang dipalsukan, FK tetap aktif.
- **VPS DEPLOYMENT: NOT READY.** Build dan 2478 test lulus, tetapi deploy akan gagal karena `deploy.sh` tidak ada dan kode belum di-push; kalaupun dipaksa, pembayaran iPaymu gagal (APP_URL localhost), payout dapat tersimulasi tanpa transfer (`PAYOUT_*` kosong), nginx/PM2 belum ada, dan WhatsApp belum siap.

**Artefak:**
- Backup: `/home/reksa/order-cleanup-backups/toko-2026-10-19T04-33-55-681Z.sql.gz` (SHA-256 `635d73c2…8d55`)
- Arsip: `/home/reksa/order-cleanup-archives/final-reset-2026-10-19T04-33-18-394Z/`
- Laporan ini: `docs/order-cleanup/FINAL-RESET-AND-DEPLOY-READINESS.md`
