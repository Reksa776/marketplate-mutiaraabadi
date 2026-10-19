# ORDER CASCADE CLEANUP — Implementasi, Dry-Run & Pengujian

**Status: implementasi selesai, DRY-RUN dijalankan, `--execute` TIDAK dijalankan.**
Database development tidak berubah (`order` tetap 163 baris). Tidak ada commit/push/deploy,
tidak ada restart PM2, tidak ada perubahan `.env`.

| Item | Nilai |
|---|---|
| CLI | `scripts/order-cascade-cleanup.ts` |
| Test | `__tests__/order-cleanup/order-cascade-cleanup.e2e.ts` |
| Laporan JSON dry-run | `docs/order-cascade-cleanup-dry-run.json` |
| Database dry-run | `toko` (development, MariaDB 11.8.8) |
| Fingerprint dry-run | `7238ef38f80112a5…` (64 hex lengkap di JSON) |
| Status dry-run | **BLOCKED** (schema drift + kewajiban finansial) |
| Hasil test | **55/55 PASS** pada database disposable |

---

## A. Hasil audit schema aktual

Sumber: `prisma/schema.prisma` + `information_schema` (bukan asumsi).

- 45 tabel, **semua InnoDB** → transaksi aman.
- 56 foreign key; 7 di antaranya menunjuk `order` langsung.
- 0 trigger, 0 event scheduler, 0 stored routine.
- Tidak ada tabel `payment`, `paymentcallback`, `checkoutevent`, `codreview`,
  `trackinghistory`. Data pembayaran melekat pada kolom `order`
  (`paymentNo`, `paymentUrl`, `qrString`, `paymentReference`, `paidAt`, `paymentExpiresAt`).

### FK langsung ke `order`

| Child | Kolom | ON DELETE |
|---|---|---|
| `orderitem` | `orderId` | CASCADE |
| `shipmentjob` | `orderId` | CASCADE |
| `guestrecoverychallenge` | `orderId` | CASCADE |
| `refund` | `orderId` | **NO ACTION** |
| `affiliateconversion` | `orderId` | **RESTRICT** |
| `notification` | `orderId` | SET NULL |
| `spinwheelspin` | `orderId` | SET NULL |

### Relasi logis tanpa FK

- `adminauditlog.entityId` saat `entityType='Order'` → 387 baris (audit, tidak dihapus).
- `whatsapp_chat_state.verifiedOrderId` → tabel **tidak ada** di DB dev.

### Drift & validasi migration (BLOCKING)

| Temuan | Detail |
|---|---|
| Tabel schema hilang di DB | `whatsapp_chat_state`, `whatsapp_inbound_message` |
| Migration belum diterapkan | `20261013120000_whatsapp_autoreply_state` |
| Migration gagal/rolled-back | tidak ada (percobaan gagal lama sudah berhasil diulang; CLI tidak lagi salah menandainya) |
| Tabel di DB di luar schema | tidak ada |

> **Temuan tambahan dari pengujian:** `prisma migrate deploy` **gagal** membuat database
> kosong. Migration `0_baseline` tidak lengkap — migrasi `20260820095404` gagal dengan
> `Table '…voucher' doesn't exist`. Artinya repo ini **tidak bisa** membangun ulang DB dari
> migration; restore harus dari dump. Jangan menjalankan `migrate deploy` di production.

---

## B. Dependency graph `order`

Dibangun runtime dari FK (`child → parent`) dan BFS dari `order`:

```
order  (DELETE)
├── orderitem                <- order.orderId  [CASCADE]    DELETE
├── shipmentjob              <- order.orderId  [CASCADE]    DELETE
├── guestrecoverychallenge   <- order.orderId  [CASCADE]    DELETE
├── refund                   <- order.orderId  [NO ACTION]  DELETE
├── affiliateconversion      <- order.orderId  [RESTRICT]   DELETE
├── notification             <- order.orderId  [SET NULL]   DELETE (hanya orderId NOT NULL)
└── spinwheelspin            <- order.orderId  [SET NULL]   PRESERVE (entitlement user)
```

Urutan hapus = depth menurun (anak dulu), lalu `order`. `refund` dan
`affiliateconversion` **wajib** dihapus lebih dulu, jika tidak FK akan menolak.

Tabel lain yang tidak punya jalur FK ke `order` tidak pernah dihapus, meskipun
`order` menunjuk ke sana (`user`, `voucher`, `shippingdiscount`).

---

## C. Daftar tabel DELETE dan PRESERVE

### DELETE (turunan eksklusif order)

| Tabel | Predikat | Baris (dev) |
|---|---|---:|
| `orderitem` | `orderId IN (semua order)` | 153 |
| `notification` | `orderId IS NOT NULL` | 46 |
| `refund` | `orderId IN (semua order)` | 6 |
| `affiliateconversion` | `orderId IN (semua order)` | 17 |
| `shipmentjob` | `orderId IN (semua order)` | 0 |
| `guestrecoverychallenge` | `orderId IN (semua order)` | 0 |
| `order` | semua | 163 |

Total baris target: **385**.

### PRESERVE (38 tabel, diverifikasi pasca-eksekusi)

`user` (402), `account` (4), `session`, `verificationtoken`, `product` (28),
`productvariant` (8, **stok tidak diubah**), `cart` (7), `cartitem` (4),
`useraddress` (15), `storesetting` (1), `province`/`regency`/`district`/`village`/
`rajaongkirregion`, `voucher` (2), `voucherproduct`, `vouchercategory`,
`shippingdiscount` (6), `bulkdiscount`, `productdiscount`, `campaign`,
`campaignproduct`, `campaigncategory`, `promotion`, `flashsale` (2),
`flashsalepurchase`, `spinwheelcampaign`, `spinwheelreward`, `spinwheelspin` (13),
`broadcast`, `affiliateprofile` (15), `affiliatekyc` (2), `affiliateclick` (7),
`affiliatepayout` (5), `adminauditlog` (875), `voucheruserusage`, `_prisma_migrations`,
`whatsapp_chat_state`/`whatsapp_inbound_message` (bila ada).

### AMBIGUOUS — tidak dihapus, keputusan manual

| Item | Baris (dev) | Catatan |
|---|---:|---|
| `notification` tanpa `orderId` | 21 | payload mungkin memuat data order lama |
| `adminauditlog` `entityType='Order'` | 387 | audit wajib; akan menggantung |
| `voucheruserusage` | 1 | kuota per-user; `usageCount=0` (drift) |
| `flashsalepurchase` | 0 | reservasi flash sale |
| `spinwheelspin` | 13 | entitlement user, bukan riwayat order |
| `whatsapp_chat_state` terikat order | 0 | tabel belum ada di dev |
| `voucher.usedCount` / `shippingdiscount.usedCount` / `product.sold` | 1 / 144 / 100 | counter tidak di-reset |

---

## D. Source code CLI

**`scripts/order-cascade-cleanup.ts`** (1.146 baris). Bagian penting:

1. **Inspeksi read-only** — `information_schema` untuk tabel, kolom, FK, `_prisma_migrations`;
   membaca `prisma/schema.prisma` dan folder `prisma/migrations` untuk validasi.
2. **Dependency graph** — BFS dari `order`; tabel turunan yang tidak dikenal → `BLOCKED`.
3. **Klasifikasi eksplisit** — `DELETE_RULES`, `PRESERVE_TABLES`, `AMBIGUOUS_TABLES`.
   Nama tabel/kolom tidak pernah dikarang: semua divalidasi terhadap DB aktual.
4. **Fingerprint** — SHA-256 dari `db + versi server + daftar tabel + migration applied +
   jumlah order + max(order.id)`. Wajib sama saat `--execute`.
5. **Gate eksekusi** (semua wajib): `--execute`, `--confirm-all-orders=DELETE-ALL-ORDERS`,
   `--database-fingerprint`, `--backup`, `--maintenance-confirmed`, `--writers-stopped`,
   `--mengantar-clear`, `--obligations-reconciled` (+ `--i-understand-production` untuk DB remote).
6. **Verifikasi backup** — file ada, > 0 byte, umur ≤ 24 jam, magic gzip / header `-- MySQL dump`,
   dan `sha256` sidecar bila tersedia.
7. **Eksekusi** — satu transaksi InnoDB, `GET_LOCK`, re-cek fingerprint & kewajiban di dalam
   transaksi, hapus anak → induk per batch, post-check (order = 0, turunan = 0, semua tabel
   PRESERVE jumlahnya identik). Gagal → rollback.
8. **Tanpa** TRUNCATE, DROP DATABASE, `FOREIGN_KEY_CHECKS=0`, panggilan Mengantar/WhatsApp/payment,
   dan tanpa menyentuh file upload / direktori auth.
9. **Output** — ringkasan agregat; tidak mencetak `DATABASE_URL`, password, token, nama/telepon/alamat.

Mode & exit code:

| Argumen | Efek |
|---|---|
| *(tanpa argumen)* / `--dry-run` | dry-run, cetak laporan manusia |
| `--report-json` | dry-run, JSON ke stdout |
| `--report-json=<path>` | dry-run, JSON ke file + ringkasan |
| `--execute` + semua gate | eksekusi |
| exit `0` | READY (dry-run) / eksekusi sukses |
| exit `2` | BLOCKED atau gate ditolak — **tidak ada perubahan** |
| exit `1` | kegagalan runtime; transaksi rollback |

---

## E. Hasil dry-run pada development

```
mode        : dry-run
status      : BLOCKED
database    : toko (11.8.8-MariaDB, local)
fingerprint : 7238ef38f80112a5
orders      : 163
rows target : 385
```

Status **BLOCKED** karena:

1. Schema drift — `whatsapp_chat_state`, `whatsapp_inbound_message` tidak ada;
   migration `20261013120000_whatsapp_autoreply_state` belum diterapkan.
2. Kewajiban belum direkonsiliasi:
   - refund `PENDING/PROCESSING`: **2**
   - komisi affiliate `PENDING/APPROVED/PAID`: **12**
   - affiliate payout `PENDING/PROCESSING`: **4**
   - COD belum selesai: **18**
   - `PAID` belum `COMPLETED`: **33**
3. Peringatan: 21 notification tanpa `orderId` dipertahankan.

Rincian lengkap + dependency graph + 38 tabel PRESERVE:
`docs/order-cascade-cleanup-dry-run.json`.

Catatan: `max(order.id)=1819` dengan 163 baris → ada celah id dari penghapusan manual sebelumnya.
Reset AUTO_INCREMENT tidak dilakukan.

---

## F. Hasil pengujian

```bash
DATABASE_URL="mysql://…/toko" \
  npx tsx __tests__/order-cleanup/order-cascade-cleanup.e2e.ts
# RESULT: 55 passed, 0 failed
```

Database disposable `toko_cleanup_test_<ts>` dibuat, diisi fixture, lalu **di-drop**.
Tidak menyentuh DB development. Karena migration tidak bisa membangun DB kosong,
fixture memakai `prisma db push` + tabel `_prisma_migrations` yang di-seed.

| # | Skenario | Hasil |
|---|---|---|
| 1 | Default run = dry-run, exit 0, status READY pada fixture bersih | PASS |
| 2 | Dry-run berulang tidak mengubah data; fingerprint stabil | PASS |
| 3 | `--execute` tanpa gate ditolak (exit 2), data utuh | PASS |
| 4 | `--confirm-all-orders` salah ditolak | PASS |
| 5 | Fingerprint salah ditolak; pesan menyebut gate fingerprint | PASS |
| 6 | Backup kosong/corrupt ditolak; pesan menyebut gate backup | PASS |
| 7 | Refund `PENDING` yang belum direkonsiliasi memblokir eksekusi | PASS |
| 8 | Kegagalan di tengah transaksi (trigger `SIGNAL`) → rollback penuh | PASS |
| 9 | Eksekusi valid: order, orderitem, refund, conversion, shipmentjob, OTP, notifikasi terhapus | PASS |
| 10 | User, product, variant (+stok), storesetting, voucher, audit, spin, cart, notifikasi unlinked tetap ada | PASS |
| 11 | FK constraint tetap ada; tidak ada orphan | PASS |
| 12 | Sumber tidak memuat import eksternal, `fetch`, `child_process`, TRUNCATE, DROP DATABASE, FK disable | PASS |

Keterbatasan pengujian:

- Fixture memakai `db push` (bukan migration) karena baseline migration rusak — lihat §A.
- Uji "tidak ada panggilan eksternal" bersifat source-inspection; tidak ada jaringan yang diblokir.
- Database disposable memakai MariaDB lokal yang sama; bukan VPS production.

---

## G. Risiko operasional dan finansial

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Refund terbuka dihapus | Uang keluar tanpa jejak | Gate `--obligations-reconciled` + hitungan refund; CLI BLOCKED |
| Komisi/payout affiliate | Saldo affiliator berubah, sengketa | Selesaikan payout dulu; conversion PAID/APPROVED memblokir |
| Jejak pembayaran | Hanya ada di `order`; hilang permanen | Backup + arsip; gate payment window |
| Settlement telat dari iPaymu/Midtrans | Uang masuk tanpa order | Hentikan intake, pastikan tidak ada VA/QRIS aktif |
| Mengantar | Shipment aktif tidak diketahui lokal | Gate `providerShipmentId` / `shipmentStatus` / ShipmentJob |
| Audit menggantung | 387 entri menunjuk order hilang | Keputusan bisnis; audit tetap disimpan |
| Counter stale | `voucher.usedCount`, `shippingdiscount.usedCount`, `product.sold` tidak akurat | Rekonsiliasi terpisah, tidak otomatis |
| Stok | Tidak direstock | Keputusan bisnis; CLI tidak mengubah stok |
| Fingerprint berubah | Trafik baru membatalkan eksekusi | Maintenance window + `--writers-stopped` |
| Backup berisi PII | Kebocoran | izin 600, folder terbatas, retensi terbatas |

Tidak ada operasi yang mengirim WhatsApp, memanggil Mengantar, atau menghubungi payment gateway —
diverifikasi oleh test source-inspection dan tidak ada import jaringan di CLI.

---

## H. Instruksi backup dan recovery

**Belum dijalankan.** Tanpa password di argumen CLI.

```bash
umask 077
install -d -m 700 /var/backups/mutiara
TS=$(date +%Y%m%d-%H%M%S)

mariadb-dump --defaults-extra-file=/root/.my.cnf \
  --single-transaction --quick --lock-tables=false \
  --routines --triggers --events --hex-blob \
  --default-character-set=utf8mb4 \
  <DB_NAME> | gzip -9 > /var/backups/mutiara/<DB_NAME>-$TS.sql.gz

sha256sum /var/backups/mutiara/<DB_NAME>-$TS.sql.gz \
  > /var/backups/mutiara/<DB_NAME>-$TS.sql.gz.sha256
chmod 600 /var/backups/mutiara/<DB_NAME>-$TS.sql.gz*
```

Verifikasi:

```bash
gzip -t /var/backups/mutiara/<DB_NAME>-$TS.sql.gz && echo GZIP_OK
sha256sum -c /var/backups/mutiara/<DB_NAME>-$TS.sql.gz.sha256
```

Uji restore ke DB terpisah (wajib sebelum eksekusi):

```bash
mariadb --defaults-extra-file=/root/.my.cnf \
  -e "CREATE DATABASE toko_restore_verify_$TS CHARACTER SET utf8mb4"
zcat /var/backups/mutiara/<DB_NAME>-$TS.sql.gz \
  | mariadb --defaults-extra-file=/root/.my.cnf toko_restore_verify_$TS
```

Bandingkan jumlah baris per tabel dengan sumber, lalu hapus DB verifikasi setelah disetujui.
**Jangan** memakai `prisma migrate deploy` untuk recovery: baseline migration tidak lengkap.

Rollback bila eksekusi sudah commit tetapi hasilnya salah:

```bash
pm2 stop <app>
mariadb --defaults-extra-file=/root/.my.cnf <DB_NAME> < dump.sql
pm2 start <app>
```

---

## I. Panduan penggunaan CLI

### 1. Dry-run (default, aman)

```bash
npx tsx scripts/order-cascade-cleanup.ts
npx tsx scripts/order-cascade-cleanup.ts --dry-run
npx tsx scripts/order-cascade-cleanup.ts --report-json > report.json
npx tsx scripts/order-cascade-cleanup.ts --report-json=docs/order-report.json
```

Exit `0` = READY, exit `2` = BLOCKED (tetap menampilkan laporan lengkap).

### 2. Membaca fingerprint

Ambil `fingerprint` (64 hex) dari JSON dry-run. Fingerprint berubah bila jumlah/max id order,
daftar tabel, atau migration berubah → **ulangi dry-run**.

### 3. Eksekusi (hanya setelah semua gate terpenuhi)

```bash
npx tsx scripts/order-cascade-cleanup.ts \
  --execute \
  --confirm-all-orders=DELETE-ALL-ORDERS \
  --database-fingerprint=<fingerprint-64-hex> \
  --backup=/var/backups/mutiara/<dump>.sql.gz \
  --maintenance-confirmed \
  --writers-stopped \
  --mengantar-clear \
  --obligations-reconciled \
  --i-understand-production
```

Urutan yang disarankan:

1. Hentikan app + cron `shipment-reconcile` (maintenance window).
2. Pastikan tidak ada refund/komisi/payout/COD/PAID yang belum selesai.
3. Backup + verifikasi + uji restore.
4. Dry-run di production, catat fingerprint, periksa status READY.
5. Jalankan `--execute` dengan gate lengkap.
6. Verifikasi pasca-eksekusi (order 0, master utuh), lalu nyalakan app + cron.

### 4. Yang TIDAK dilakukan CLI

- Tidak menghapus user, produk, varian, stok, kategori, settings, voucher master,
  affiliate profile/KYC/payout, audit log, spin entitlement, cart, atau sesi WhatsApp.
- Tidak merestock stok, tidak mereset `product.sold` / `usedCount`, tidak reset AUTO_INCREMENT.
- Tidak menghapus notification tanpa `orderId` (ambigu).
- Tidak memanggil API eksternal apa pun.

---

## Ringkasan keputusan

**DRY-RUN: BLOCKED — jangan eksekusi.** Dua kelompok alasan:

1. Schema drift (2 tabel hilang, 1 migration tertunda).
2. Kewajiban finansial/operasional belum direkonsiliasi (2 refund, 12 komisi, 4 payout,
   18 COD, 33 PAID belum selesai).

Setelah keduanya diselesaikan, dry-run harus berstatus **READY** dan fingerprint baru
dipakai untuk `--execute`. Menunggu persetujuan eksplisit sebelum tindakan production.
