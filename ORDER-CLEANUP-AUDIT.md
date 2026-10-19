# AUDIT DATABASE & RENCANA PEMBERSIHAN DATA ORDER — MUTIARA ABADI

**Status: AUDIT ONLY — tidak ada data yang dihapus, diubah, atau dimigrasi.**
Dokumen ini adalah laporan Fase 1–5. Eksekusi menunggu persetujuan eksplisit.

| Item | Nilai |
|---|---|
| Database yang diaudit | development `/home/reksa/demo-marketplace` (DB `toko`) |
| Server DB | MariaDB 11.8.8 |
| Tabel | 45 (44 domain + `_prisma_migrations`) |
| Total baris | 5.895 |
| Order | 163 (13 Agu 2026 – 28 Sep 2026) |
| Engine | 45/45 InnoDB (transaksi aman) |
| Trigger / Event / Routine | 0 / 0 / 0 |
| Production | **TIDAK dapat diakses dari mesin ini** (`/home/mutiaraabadi` tidak ada) |

Verifikasi read-only: `order` tetap 163 baris dan `orderitem` 153 baris sebelum dan sesudah audit.

> **Penting:** angka di bawah berasal dari DB **development**, yang ternyata banyak berisi data uji
> (105 nomor `PAY-*`, 13 `TEST-*`, 2 `ORD-TITLE-VERIFY-*`). Angka production **wajib** diambil
> ulang dengan `docs/ORDER-CLEANUP-AUDIT.sql` sebelum keputusan akhir. Jangan pakai angka dev
> sebagai `--confirm` di production.

---

## A. Daftar seluruh tabel dan jumlah record (aktual, `COUNT(*)`)

| Tabel | Baris | Kategori |
|---|---:|---|
| district | 1.811 | A — master wilayah |
| village | 1.178 | A — master wilayah |
| regency | 1.003 | A — master wilayah |
| adminauditlog | 875 | C — audit, **wajib dipertahankan** |
| user | 402 | A — master (2 ADMIN, 400 CUSTOMER) |
| **order** | **163** | B/C — target |
| **orderitem** | **153** | B — turunan order |
| notification | 67 | B/C — turunan order (46 terhubung) |
| province | 54 | A — master wilayah |
| _prisma_migrations | 29 | A — metadata Prisma |
| product | 28 | A — master produk |
| affiliateconversion | 17 | C — komisi (12 masih live) |
| affiliateprofile | 15 | A — master affiliate |
| useraddress | 15 | A — master alamat |
| spinwheelspin | 13 | C — entitlement user (0 terhubung order) |
| productvariant | 8 | A — master varian/stok |
| affiliateclick | 7 | A — tracking klik |
| cart | 7 | A/C — 1 cart guest |
| spinwheelreward | 7 | A — konfigurasi |
| **refund** | **6** | C — 2 masih terbuka |
| shippingdiscount | 6 | A — master promo (usedCount drift) |
| affiliatepayout | 5 | C — 4 masih terbuka |
| broadcast | 5 | A — riwayat broadcast |
| account | 4 | A — auth |
| cartitem | 4 | A/C |
| affiliatekyc | 2 | A — data KYC (sensitif) |
| bulkdiscount | 2 | A — konfigurasi |
| flashsale | 2 | A — konfigurasi |
| voucher | 2 | A — master voucher |
| campaign | 1 | A — konfigurasi |
| productdiscount | 1 | A — konfigurasi |
| spinwheelcampaign | 1 | A — konfigurasi |
| storesetting | 1 | A — konfigurasi toko |
| voucheruserusage | 1 | C — kuota per-user |
| campaigncategory | 0 | A |
| campaignproduct | 0 | A |
| flashsalepurchase | 0 | B |
| guestrecoverychallenge | 0 | B |
| promotion | 0 | A |
| rajaongkirregion | 0 | A |
| session | 0 | A |
| **shipmentjob** | **0** | B |
| verificationtoken | 0 | A |
| vouchercategory | 0 | A |
| voucherproduct | 0 | A |

**Tidak ada** tabel `payment`, `paymentcallback`, `checkoutevent`, `codreview`, `trackinghistory`,
atau `whatsapp_*` di database ini. Yang tidak ada tidak bisa dibersihkan — rinciannya di §B/§F.

### Drift schema (temuan penting)

1. `prisma/schema.prisma` mendefinisikan `WhatsAppChatState` (`whatsapp_chat_state`) dan
   `WhatsAppInboundMessage` (`whatsapp_inbound_message`), tetapi **kedua tabel tidak ada di DB**.
2. Migration terakhir `20261013120000_whatsapp_autoreply_state` **belum diterapkan**.
3. `_prisma_migrations` berisi 1 migration yang pernah **FAIL lalu ROLLED_BACK**
   (`20260922020000_add_tiktok_pixel_enabled`) sebelum dijalankan ulang.

Artinya DB dan `schema.prisma` **tidak identik**. Script pembersihan sudah tahan terhadap hal ini
(cek `information_schema` sebelum menyentuh tabel), tetapi drift ini harus diselesaikan terpisah
dan **tidak** termasuk dalam lingkup pembersihan.

---

## B. Relasi tabel `order` (dari information_schema, bukan asumsi)

### Anak langsung (baris yang ikut/terdampak saat order dihapus)

| Child table | Kolom | ON DELETE | Dampak |
|---|---|---|---|
| `orderitem` | `orderId` | **CASCADE** | 153 baris ikut terhapus |
| `shipmentjob` | `orderId` | **CASCADE** | 0 baris di dev |
| `guestrecoverychallenge` | `orderId` | **CASCADE** | 0 baris |
| `refund` | `orderId` | **NO ACTION (RESTRICT)** | **6 baris menghalangi delete** |
| `affiliateconversion` | `orderId` | **RESTRICT** | **17 baris menghalangi delete** |
| `notification` | `orderId` | **SET NULL** | 46 baris jadi orphan (payload berisi data order) |
| `spinwheelspin` | `orderId` | **SET NULL** | 0 baris terhubung |
| `whatsapp_chat_state` | `verifiedOrderId` (**tanpa FK**) | — | tabel tidak ada di DB ini; di prod bisa meninggalkan referensi menggantung |

### Orang tua (order menunjuk ke sini — jangan dihapus)

`user` (SET NULL), `voucher` (SET NULL), `shippingdiscount` (SET NULL),
`spinwheelspin.originalSpinWheelSpinId` (SET NULL).

### Relasi logis tanpa FK

- `adminauditlog.entityType='Order'` + `entityId` → 387 baris audit menunjuk order (akan menggantung).
- `notification.payload` memuat `orderNumber`, `total`, `items`, `trackingNumber` (data order nyata).

**Kesimpulan:** menghapus tabel `order` saja **tidak cukup dan tidak mungkin** — 23 baris
(`refund` + `affiliateconversion`) akan memblokir dengan error FK 1451, dan `notification`
akan menjadi orphan tanpa peringatan.

---

## C. Tabel yang aman menjadi kandidat penghapusan (Kategori B)

| Tabel | Baris | Alasan aman |
|---|---:|---|
| `order` (subset) | 83 / 163 | Order tertutup tanpa kewajiban aktif |
| `orderitem` | 86 dari 153 | Anak CASCADE, snapshot harga/nama tersimpan di baris |
| `refund` | 4 dari 6 | Hanya yang berstatus `COMPLETED` |
| `affiliateconversion` | 1 dari 17 | Hanya yang `CANCELLED`/`REVERSED` |
| `shipmentjob` | 0 | Tidak ada baris |
| `guestrecoverychallenge` | 0 | OTP sekali pakai, kedaluwarsa |
| `notification` | 8 dari 67 | Turunan order; payload berisi data order |
| `whatsapp_chat_state` | 0 | Tidak ada di DB ini |

Tidak ada data transaksi lain yang aman dihapus otomatis di DB ini.

---

## D. Tabel yang WAJIB dipertahankan (Kategori A)

`user`, `account`, `session`, `verificationtoken`, `product`, `productvariant` (harga & **stok**),
`storesetting`, `province`/`regency`/`district`/`village`/`rajaongkirregion`,
`voucher`, `voucherproduct`, `vouchercategory`, `shippingdiscount`, `bulkdiscount`,
`productdiscount`, `campaign`, `campaignproduct`, `campaigncategory`, `promotion`,
`flashsale`, `campaign`, `spinwheelcampaign`, `spinwheelreward`,
`affiliateprofile`, `affiliatekyc`, `affiliateclick`,
`adminauditlog`, `broadcast`, `cart`/`cartitem` (cart aktif, bukan riwayat), `useraddress`.

Konfigurasi eksternal yang **tidak boleh disentuh**: `storesetting.mengantar*`,
`WHATSAPP_AUTH_DIR` (sesi Baileys di filesystem, **bukan** di DB), seluruh `.env`.

---

## E. Tabel / baris yang memerlukan keputusan manual (Kategori C)

| # | Item | Kondisi aktual (dev) | Mengapa manual |
|---|---|---|---|
| C1 | Refund terbuka | **2** — order #87 Rp34.000 (`PROCESSING`), #783 Rp59.500 (`PENDING`) | Uang keluar belum selesai; FK `NO ACTION` memblokir delete |
| C2 | Komisi affiliate live | **12** — PENDING 1, APPROVED 9, PAID 2; nilai **Rp184.950** | RESTRICT + kewajiban bayar |
| C3 | Payout affiliate terbuka | **4** — Rp8.000, Rp3.000, Rp52.450, Rp85.000 (total Rp148.450) | Kewajiban finansial ke affiliator |
| C4 | Order PAID belum COMPLETED | **33** | Barang belum dikirim / uang sudah masuk |
| C5 | COD belum selesai | **18** | Barang bisa masih di jalan, uang belum diterima |
| C6 | Order REFUND_PENDING | **2** (#87, #783) | Sama dengan C1 |
| C7 | Audit log order | **387** baris (`ORDER_STATUS_CHANGED` 184, `ORDER_CANCELLED` 182, `REPAYMENT_INITIATED` 21) | Audit wajib dipertahankan; akan menggantung tanpa order |
| C8 | Kuota voucher | `voucher.usedCount=1` (quota 4), `voucheruserusage` 1 baris `usageCount=0` | Angka tidak konsisten; reset butuh keputusan bisnis |
| C9 | Kuota diskon ongkir | `shippingdiscount.usedCount=144` pada 5 baris, salah satunya **134** padahal hanya 4 order memakai | Counter sudah drift; jangan di-reset tanpa rekonsiliasi |
| C10 | Stok & `product.sold` | `product.sold` total 100 pada 5 produk; stok varian tidak diubah | Pembersihan order **tidak** merestock; keputusan bisnis |
| C11 | Spin wheel | 13 spin `AVAILABLE`, 0 terhubung order; `usedQuantity` reward = 13 | Ini entitlement user, bukan riwayat order |
| C12 | Notifikasi WhatsApp | 67 baris (46 terhubung order), 57 `FAILED` | Payload memuat data order; hapus atau simpan |
| C13 | `flashsalepurchase` | 0 baris | — |
| C14 | Order tanpa item | **15** (`TEST-*`, `ORD-TITLE-VERIFY-*`) | Data uji; bisa dihapus duluan |

---

## F. Risiko penghapusan dan dampak operasional

### F1. Risiko foreign key / cascade (terverifikasi)

- `refund` = **NO ACTION** → delete order gagal (1451) bila refund belum dihapus.
- `affiliateconversion` = **RESTRICT** → delete order gagal bila komisi masih ada.
- `notification` = **SET NULL** → **tidak** gagal, tetapi 46 baris jadi yatim tanpa peringatan.
- `orderitem` = **CASCADE** → 153 baris hilang otomatis (script tetap menghapus eksplisit agar terhitung).
- `order.originalSpinWheelSpinId` menunjuk `spinwheelspin` (SET NULL arah sebaliknya) → spin tetap aman.

### F2. Dampak ke stok produk

Stok **tidak** berubah bila order dihapus langsung (tidak ada trigger). `productvariant.stock`
tetap seperti sekarang, dan `product.sold` tetap 100. Artinya: riwayat hilang tetapi counter
"terjual" dan stok tetap mencerminkan penjualan lama. Script **tidak** menyentuh keduanya.
Rekonsiliasi stok/sold memerlukan analisis dan persetujuan terpisah.

### F3. Dampak ke komisi affiliate

`affiliateconversion` RESTRICT. Menghapus 17 baris konversi = menghapus bukti komisi
**Rp207.400** (Rp184.950 di antaranya masih hidup). Saldo affiliate dihitung dari
`SUM(APPROVED+PAID) - SUM(payout)`, jadi menghapus konversi membuat saldo affiliator **turun**
tanpa payout. Ini tindakan finansial, bukan pembersihan teknis.

Temuan tambahan: ada komisi `APPROVED`/`PAID` yang menempel pada order berstatus **PENDING**
(6 APPROVED + 2 PAID). Ini anomali bisnis yang perlu ditinjau, bukan dihapus otomatis.

### F4. Dampak ke kuota voucher & promo

- `voucher.usedCount` 1 dan `voucheruserusage` 1 baris tidak akan dikembalikan otomatis.
  Jika order dihapus tanpa reset, kuota tetap "terpakai" selamanya.
- `shippingdiscount.usedCount` **sudah** tidak konsisten (134 pada satu baris) — jangan dijadikan
  dasar reset otomatis.
- `flashsale.soldCount` = 0 sehingga tidak ada reservasi flash sale yang perlu dilepas.

### F5. Dampak ke ShipmentJob & Mengantar

- `shipmentjob` = 0 baris, `providerShipmentId` = 0, `shipmentStatus` aktif = 0.
  Di dev, tidak ada shipment yang berjalan.
- Di production angka ini **wajib** dicek ulang: order dengan `providerShipmentId` tidak boleh
  dihapus sebelum shipment ditutup di sisi Mengantar. Script memblokir kondisi ini.
- Riwayat pelacakan tidak disimpan lokal (hanya di Mengantar), jadi tidak ada tabel tracking
  yang perlu dibersihkan.

### F6. Dampak ke pembayaran & refund

- **Tidak ada tabel `payment`.** Nomor VA, URL QRIS, `paymentReference`, `paidAt`,
  `paymentExpiresAt` semuanya **kolom di `order`**. Menghapus order = **menghapus satu-satunya
  jejak pembayaran**.
- Notifikasi iPaymu/Midtrans bisa datang **setelah** cleanup untuk VA/QRIS lama. Route akan
  menganggap order tidak dikenal dan menolak — uang bisa masuk tanpa order. Karena itu
  order dengan pembayaran aktif/kedaluwarsa belum wajar harus dikecualikan.
- `refund` terbuka memblokir delete (lihat C1).

### F7. Dampak ke WhatsApp auto-reply & pelacakan order

- `whatsapp_chat_state.verifiedOrderId` **tanpa FK**. Jika tabel ini ada di production, order yang
  dihapus meninggalkan chat yang "terikat" ke order yang tidak ada; bot bisa gagal saat tracking.
  Script menyediakan `--clear-whatsapp-bindings` (opsional, default **off**).
- Sesi Baileys ada di filesystem (`WHATSAPP_AUTH_DIR`), **tidak** tersentuh.
- Pelacakan via resi (`trackingNumber`, `trackingUrl`) tersimpan di order → hilang bersama order.
- `notification` order-derived dihapus default (payload memuat nomor order, total, item).

### F8. Penulis background yang bisa membuat/mengubah order saat cleanup

| Penulis | Pemicu | Risiko |
|---|---|---|
| `lib/checkout.ts` (`tx.order.create`) | `POST /api/checkout`, `/api/buy-now*`, `/api/payment/ipaymu` | Order baru di tengah cleanup |
| `POST /api/payment/ipaymu/notification` | callback iPaymu | Mengubah `paymentStatus`/`status`, membuat ShipmentJob |
| `POST /api/payment/midtrans/notification` | callback Midtrans | Sama |
| `POST /api/orders/[id]/expire` | halaman pembayaran (client) | Melepas stok/kuota, set EXPIRED |
| `POST|GET /api/cron/shipment-reconcile` | **cron eksternal** (tidak ada cron in-process) | Memproses ShipmentJob |
| `POST /api/admin/shipments/process` | admin | Sama |
| `POST /api/mengantar/webhook` | Mengantar | Mengubah `shipmentStatus` |
| `POST /api/orders/[id]` (cancel) | user/admin | Soft-cancel + release stok |
| `instrumentation.ts` → Baileys bootstrap | start server | Menulis chat state (tabel belum ada di DB) |
| `lib/rate-limit.ts` `setInterval` | in-process | Hanya memori, tidak menulis order |

Tidak ada `/api/cron/*` lain dan tidak ada job scheduler in-process untuk order. **Namun**
`/api/cron/shipment-reconcile` dipanggil cron eksternal dan **wajib dimatikan** selama cleanup.
Script memakai advisory lock + pemeriksaan `MAX(order.id)` di dalam transaksi untuk menolak
order yang muncul di tengah jalan.

### F9. Risiko lain

- `adminauditlog` tidak bisa dihapus (keputusan audit) → 387 entri menunjuk ke order yang hilang.
- Backup berisi PII (nama, telepon, alamat, KTP affiliate) → wajib izin 600 dan lokasi terbatas.
- `order.id` punya celah (29–1819, hanya 163 baris) → riwayat penghapusan manual sudah pernah terjadi.

---

## G. Rencana backup dan restore

**Belum dijalankan. Butuh persetujuan.** Jangan pernah menaruh password di argumen CLI.

### G1. Backup (di VPS production)

```bash
umask 077
install -d -m 700 /var/backups/mutiara
TS=$(date +%Y%m%d-%H%M%S)

# /root/.my.cnf sudah berisi credential, mode 600, TIDAK di-print
mariadb-dump \
  --defaults-extra-file=/root/.my.cnf \
  --single-transaction --quick --lock-tables=false \
  --routines --triggers --events --hex-blob \
  --default-character-set=utf8mb4 \
  <DB_NAME> | gzip -9 > /var/backups/mutiara/<DB_NAME>-$TS.sql.gz

sha256sum /var/backups/mutiara/<DB_NAME>-$TS.sql.gz \
  > /var/backups/mutiara/<DB_NAME>-$TS.sql.gz.sha256
chmod 600 /var/backups/mutiara/<DB_NAME>-$TS.sql.gz*
```

`--single-transaction` memberi snapshot konsisten untuk InnoDB (semua tabel InnoDB — terverifikasi)
tanpa mengunci toko. Ukuran dev ±3,9 MB; production perlu diukur.

### G2. Verifikasi backup

```bash
gzip -t /var/backups/mutiara/<DB_NAME>-$TS.sql.gz && echo GZIP_OK
sha256sum -c /var/backups/mutiara/<DB_NAME>-$TS.sql.gz.sha256
# header dump + jumlah tabel
zcat /var/backups/mutiara/<DB_NAME>-$TS.sql.gz | head -20
zcat /var/backups/mutiara/<DB_NAME>-$TS.sql.gz | grep -c '^CREATE TABLE'
```

### G3. Uji restore ke database TERPISAH (wajib sebelum menghapus)

```bash
mariadb --defaults-extra-file=/root/.my.cnf \
  -e "CREATE DATABASE toko_restore_verify_$TS CHARACTER SET utf8mb4"

zcat /var/backups/mutiara/<DB_NAME>-$TS.sql.gz \
  | mariadb --defaults-extra-file=/root/.my.cnf toko_restore_verify_$TS

# bandingkan dengan sumber (harus sama)
mariadb --defaults-extra-file=/root/.my.cnf -N -B toko_restore_verify_$TS -e "
  SELECT 'order',COUNT(*) FROM \`order\`
  UNION ALL SELECT 'orderitem',COUNT(*) FROM orderitem
  UNION ALL SELECT 'user',COUNT(*) FROM user
  UNION ALL SELECT 'product',COUNT(*) FROM product
  UNION ALL SELECT 'productvariant',COUNT(*) FROM productvariant
  UNION ALL SELECT 'storesetting',COUNT(*) FROM storesetting
  UNION ALL SELECT 'affiliateconversion',COUNT(*) FROM affiliateconversion
  UNION ALL SELECT 'refund',COUNT(*) FROM refund;"
```

Hapus DB verifikasi **hanya setelah** hasil cocok dan disetujui:

```bash
mariadb --defaults-extra-file=/root/.my.cnf -e "DROP DATABASE toko_restore_verify_$TS"
```

### G4. Rollback bila cleanup gagal

1. Cleanup berjalan dalam **satu transaksi InnoDB** → kegagalan logika otomatis rollback.
2. Bila proses mati di tengah commit: transaksi tidak commit → tidak ada perubahan.
3. Bila hasil sudah commit tetapi salah:
   ```bash
   pm2 stop <app>                      # hentikan tulis
   mariadb --defaults-extra-file=/root/.my.cnf <DB_NAME> < hasil-restore.sql
   pm2 start <app>
   ```
   Restore penuh memakai dump G1 (bukan DB verifikasi).
4. Simpan dump minimal sampai sign-off bisnis (mis. 30 hari), lalu hapus sesuai kebijakan.

---

## H. Script dry-run (sudah ada di repo, READ-ONLY)

| File | Fungsi | Menulis? |
|---|---|---|
| `scripts/audit-order-cleanup.ts` | Inventaris tabel, exact count, FK aktual, trigger/event, sinyal Kategori C | **Tidak** (guard `SELECT|SHOW` only) |
| `scripts/cleanup-orders-dry-run.ts` | Simulasi per-scope: target, anak yang terdampak, snapshot master, blocker | **Tidak** |
| `docs/ORDER-CLEANUP-AUDIT.sql` | Paket SELECT-only untuk VPS production | **Tidak** |
| `scripts/cleanup-orders.ts` | Draft pembersihan; default dry-run | Hanya dengan `--execute` |

```bash
# development (audit lengkap)
npx tsx scripts/audit-order-cleanup.ts
npx tsx scripts/audit-order-cleanup.ts --json

# simulasi
npx tsx scripts/cleanup-orders-dry-run.ts --scope=all
npx tsx scripts/cleanup-orders-dry-run.ts --scope=closed

# production (di VPS, tanpa password di CLI)
mysql --defaults-extra-file=/root/.my.cnf -t < docs/ORDER-CLEANUP-AUDIT.sql
```

### Hasil simulasi (DB dev, aktual)

**Scope `all` — 163 order:**

| Anak | Baris |
|---|---:|
| orderitem | 153 |
| shipmentjob | 0 |
| guestrecoverychallenge | 0 |
| refund | 6 (2 terbuka) |
| affiliateconversion | 17 (12 live) |
| notification | 46 |
| spinwheelspin terhubung | 0 |

Blocker: 2 refund terbuka, 12 komisi live, 18 COD belum selesai, 33 order PAID belum COMPLETED.

**Scope `closed` — 83 order (80 tersisa):**

| Anak | Baris |
|---|---:|
| orderitem | 86 |
| refund (COMPLETED) | 4 |
| affiliateconversion (CANCELLED) | 1 |
| notification | 8 |
| shipmentjob / OTP | 0 |

80 order yang tersisa: 29 PENDING/UNPAID, 27 PAID/PAID, 10 PENDING/PENDING, 5 PROCESSING/PAID,
3 COMPLETED/PAID (komisi live), 2 PROCESSING/UNPAID (COD), 2 REFUND_PENDING/PAID,
1 SHIPPED/PAID, 1 PROCESSING/PENDING.

---

## I. Draft script pembersihan — **BELUM DIEKSEKUSI**

`scripts/cleanup-orders.ts`

Syarat yang dipenuhi:

- Default **dry-run**; menulis hanya dengan `--execute`.
- Wajib `--confirm=<jumlah target>` (mismatch → abort) dan `--backup=<file>` (file hilang/kosong/>24 jam → abort).
- Satu transaksi InnoDB (`timeout` 15 menit); gagal = rollback total.
- Hapus anak → induk: notification → guestrecoverychallenge → refund(COMPLETED/FAILED) →
  affiliateconversion(CANCELLED/REVERSED) → shipmentjob(DONE/FAILED/CANCELLED) → orderitem → order.
- Abort bila: FK check mati, refund terbuka, komisi PENDING/APPROVED/PAID, ShipmentJob in-flight,
  shipment aktif, `providerShipmentId` ada, COD belum selesai, order PAID belum COMPLETED.
- Advisory lock `GET_LOCK` + re-cek `MAX(order.id)` di dalam transaksi → menolak bila checkout
  membuat order di tengah proses.
- Post-check **di dalam transaksi**: jumlah order = total − target, orphan = 0, snapshot master
  (user, produk, varian/stok, settings, voucher, affiliate, audit, dll.) **harus identik**.
- Tidak memakai `migrate reset`, `DROP`, `TRUNCATE`, `SET FOREIGN_KEY_CHECKS=0`.
- Tidak menyentuh `user`, `product`, `productvariant`, `storesetting`, `affiliate*`, `adminauditlog`,
  counter voucher/ongkir/`product.sold`, dan sesi WhatsApp.
- Opsi `--keep-notifications` dan `--clear-whatsapp-bindings` (default off).

Contoh pemakaian (setelah backup terverifikasi dan persetujuan):

```bash
npx tsx scripts/cleanup-orders.ts --scope=closed        # dry-run
npx tsx scripts/cleanup-orders.ts \
  --execute --scope=closed --confirm=<N> --backup=/var/backups/mutiara/<file>.sql.gz
```

Catatan: script **tidak** mengubah stok. Bila stok ingin ikut direkonsiliasi, itu perubahan
terpisah yang butuh analisis dan persetujuan (lihat §F2).

---

## J. Checklist verifikasi setelah eksekusi

Jalankan `docs/ORDER-CLEANUP-AUDIT.sql` bagian J, lalu:

- [ ] `order`, `orderitem`, `refund`(closed), `affiliateconversion`(closed), `shipmentjob`,
      `guestrecoverychallenge` sesuai target; orphan = 0.
- [ ] `user` = 402 (dev) / angka prod sebelum cleanup — **tidak berubah**.
- [ ] `affiliateprofile` 15, `affiliatekyc` 2, `affiliateclick` 7, `affiliatepayout` 5 — **tidak berubah**.
- [ ] `product` 28, `productvariant` 8, dan **setiap** `stock` identik baris-per-baris.
- [ ] `product.sold` tetap 100 (tidak di-reset).
- [ ] `storesetting` 1 baris; kolom `mengantar*`, `tiktokPixel*` utuh.
- [ ] `voucher` 2, `shippingdiscount` 6, `flashsale` 2, `campaign` 1, `spinwheel*` utuh.
- [ ] `adminauditlog` 875 (tidak berkurang).
- [ ] `notification`: 67 − 8 = 59 (jika default hapus) atau 67 dengan 8 orphan (jika `--keep-notifications`).
- [ ] Sesi WhatsApp/Baileys tidak berubah; bot tetap terhubung setelah app restart.
- [ ] `/admin` (order list kosong/tidak error), detail order lama → 404 yang wajar.
- [ ] Storefront: produk tampil, stok & harga benar, checkout 1 order percobaan (di staging).
- [ ] Cron `shipment-reconcile` dimatikan saat cleanup dan dinyalakan kembali setelah verifikasi.
- [ ] Backup + checksum tersimpan, uji restore berhasil.

---

## K. Kesimpulan GO / NO-GO

### 1. Hapus SEMUA order sekarang (scope `all`) — **NO-GO** ❌

Alasan (semua terverifikasi, bukan asumsi):

1. **2 refund terbuka** (Rp34.000 + Rp59.500) — FK `NO ACTION` memblokir dan uangnya belum selesai.
2. **12 komisi affiliate live** senilai **Rp184.950** — FK `RESTRICT`; menghapusnya menghapus
   kewajiban finansial.
3. **18 COD belum selesai** dan **33 order PAID belum COMPLETED** — masih ada kewajiban kirim/uang.
4. **4 payout affiliate terbuka** (Rp148.450) yang basis komisinya harus tetap ada.
5. **Tidak ada tabel `payment`** → menghapus order = menghapus satu-satunya jejak pembayaran;
   callback iPaymu/Midtrans yang telat bisa masuk ke order yang sudah tidak ada.
6. Ada **387 entri audit** order yang akan menggantung (audit wajib dipertahankan).
7. Drift schema (`whatsapp_*` tidak ada, 1 migration gagal/rolled-back) → production harus
   diverifikasi ulang, jangan mengasumsikan DB dev = prod.

### 2. Hapus order TERTUTUP (scope `closed`) — **GO BERSYARAT** ⚠️

83 dari 163 order (dev) tanpa kewajiban finansial/fulfilment, dengan syarat:

- [ ] Backup penuh + checksum + **uji restore ke DB terpisah** berhasil (belum dilakukan).
- [ ] Persetujuan eksplisit untuk `--confirm=<N>` production (N dari SQL bundle, bukan angka dev).
- [ ] App **dan** cron `shipment-reconcile` dihentikan selama eksekusi (webhook tidak bisa
      dihentikan, jadi jendela eksekusi harus singkat dan tanpa order baru).
- [ ] Audit production dijalankan lebih dulu; bila ada `providerShipmentId`/shipment aktif,
      order tersebut dikecualikan.
- [ ] Keputusan manual untuk: refund terbuka, komisi live, payout terbuka, `voucher.usedCount`,
      `shippingdiscount.usedCount`, `product.sold`, spin wheel, notifikasi.
- [ ] Script dijalankan mode dry-run di production dan hasilnya identik dengan SQL bundle.

### 3. Yang TIDAK direkomendasikan

- `migrate reset`, `DROP DATABASE`, `TRUNCATE`, menonaktifkan FK, atau menghapus user/produk.
- Reset `AUTO_INCREMENT` (tidak diperlukan; celah id sudah ada).
- Menghapus `adminauditlog`, `affiliatekyc`, atau sesi WhatsApp.

---

## Ringkasan artefak

| File | Status |
|---|---|
| `scripts/audit-order-cleanup.ts` | dibuat, **read-only**, sudah dijalankan |
| `scripts/cleanup-orders-dry-run.ts` | dibuat, **read-only**, sudah dijalankan |
| `scripts/cleanup-orders.ts` | draft, **belum dieksekusi** |
| `docs/ORDER-CLEANUP-AUDIT.sql` | SELECT-only, sudah divalidasi ke DB dev |
| `ORDER-CLEANUP-AUDIT.md` | laporan ini |

**Berhenti di sini. Tidak ada DELETE/UPDATE/TRUNCATE/DROP yang dijalankan, tidak ada migration,
tidak ada perubahan `.env`, tidak ada restart PM2, tidak ada commit/push.**
Menunggu persetujuan eksplisit sebelum langkah berikutnya.
