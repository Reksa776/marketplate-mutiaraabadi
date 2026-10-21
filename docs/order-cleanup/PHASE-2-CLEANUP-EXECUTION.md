# PHASE 2 — FULL ORDER HISTORY CLEANUP

## Execution Report — HALTED BEFORE DELETE

| Item | Nilai |
|---|---|
| Tanggal | 2026-10-19 |
| Target yang diverifikasi | DB lokal/dev `toko` — MariaDB 11.8.8 (`127.0.0.1:3306`, host `webdev`) |
| Production | **Tidak diakses / tidak diubah** |
| Status eksekusi | **DIHENTIKAN SEBELUM DELETE** |
| `DELETE` dijalankan | **0** |
| `UPDATE`/`ALTER`/`DROP`/`TRUNCATE` | **0** |
| Foreign key checks dinonaktifkan manual | **Tidak** |
| Panggilan API eksternal | **Tidak ada** |
| Script cleanup lama dijalankan | **Tidak** |
| Data berubah | **Tidak ada** |

> Cakupan penghapusan yang sudah disetujui **tidak ditanyakan ulang**. Laporan ini menjelaskan hasil verifikasi, backup, arsip, dry-run, dan alasan eksekusi dihentikan sebelum `DELETE`.

---

## 1. Executive Summary

Seluruh persiapan yang aman sudah dijalankan:

1. Database target dan 56 foreign key diverifikasi ulang.
2. Backup lengkap dibuat, diuji gzip, dan **berhasil direstore** ke database disposable; 45 tabel cocok tanpa selisih, 56 FK utuh.
3. Referensi pembayaran, refund, conversion, shipment, notification, dan payout diarsipkan ke direktori aman di luar repo.
4. Dry-run dijalankan: **385 kandidat baris**, **23 order terblokir FK**, **140 order bersih**, tetapi status keseluruhan **BLOCKED**.
5. Script cleanup transaksional sudah disiapkan; dry-run dan gate eksekusi diuji. Percobaan `--execute` **ditolak sebelum transaksi** karena blocker.
6. **Tidak ada `DELETE` yang dijalankan.** Count seluruh tabel identik sebelum dan sesudah.

**Keputusan:** eksekusi **NO-GO** sampai blocker finansial dan eksternal diselesaikan. Ini sesuai instruksi: jangan menghapus kewajiban refund/payout yang belum selesai, dan jangan menganggap backup menyelesaikan risiko pembayaran/shipment yang masih berjalan.

---

## 2. Verifikasi Database Target

| Pemeriksaan | Hasil |
|---|---|
| Database | `toko` |
| Host | `127.0.0.1` / `webdev` (lokal) |
| Versi | MariaDB 11.8.8 |
| Tabel | 45, seluruhnya InnoDB |
| Foreign key total | 56 |
| FK langsung ke `order` | 7 |
| Trigger / event / routine | 0 / 0 / 0 |
| Schema drift | `whatsapp_chat_state` dan `whatsapp_inbound_message` tidak ada; migration `20261013120000_whatsapp_autoreply_state` belum diterapkan |
| `refund` ON DELETE | Prisma `Restrict`; DB `NO ACTION` (keduanya menolak delete) |
| `affiliateconversion` ON DELETE | `RESTRICT` |
| `notification` / `spinwheelspin` | `SET NULL` |
| `orderitem` / `shipmentjob` / `guestrecoverychallenge` | `CASCADE` |

FK langsung (aktual):

| Child | Kolom | ON DELETE |
|---|---|---|
| `orderitem` | `orderId` | CASCADE |
| `shipmentjob` | `orderId` | CASCADE |
| `guestrecoverychallenge` | `orderId` | CASCADE |
| `refund` | `orderId` | NO ACTION |
| `affiliateconversion` | `orderId` | RESTRICT |
| `notification` | `orderId` | SET NULL |
| `spinwheelspin` | `orderId` | SET NULL |

Tidak ada FK tingkat dua. Tidak ada tabel di luar schema di DB dev.

---

## 3. Backup dan Uji Restore

### 3.1 Backup

| Item | Nilai |
|---|---|
| File | `/home/reksa/order-cleanup-backups/toko-2026-10-19T04-00-44-629Z.sql.gz` |
| Ukuran | 115.881 byte |
| SHA-256 | `57bc09b9b898c20e9b5343d7d3c5f12c1b29b85a2d3adb6613b75dfce7b89e64` |
| Metode | `mariadb-dump --single-transaction --quick --routines --triggers --events --hex-blob` |
| Gzip test | Lulus |
| Lokasi | Di luar repo, permission ketat |

### 3.2 Uji restore

| Pemeriksaan | Hasil |
|---|---|
| Database uji | `toko_restore_verify_20261019040112` (disposable) |
| Tabel direstore | 45 |
| Selisih jumlah baris | **0** (45/45 tabel cocok) |
| FK setelah restore | 56 |
| `@@foreign_key_checks` setelah restore | 1 |
| Stok varian | 2.085 (sama) |
| `product.sold` | 100 (sama) |
| `voucher.usedCount` | 1 (sama) |
| `shippingdiscount.usedCount` | 144 (sama) |
| Total payout | 151.450 (sama) |
| Audit log | 875 (sama) |
| Spin | 13 (sama) |
| Status DB uji | Dihapus setelah verifikasi |

Catatan: dump standar membawa session-scoped FK toggle saat import ke database disposable. Tidak ada penonaktifan FK manual pada operasi cleanup; setelah restore nilainya kembali 1.

---

## 4. Arsip Referensi

Lokasi: `/home/reksa/order-cleanup-archives/phase2-2026-10-19T04-01-34-875Z` (di luar repo, direktori `700`, file `600`).

| File | Baris | Ukuran | SHA-256 |
|---|---:|---:|---|
| `orders-payment-shipment.csv` | 163 | 31.453 | `63738711efb841d17ae657407c0ae8053e72ef6c73f5d10ff09325a0494c4888` |
| `refunds.csv` | 6 | 1.155 | `0c31edaa65895992ce300c926649930759475540747ffb33ff2fd27503e9291e` |
| `affiliate-conversions.csv` | 17 | 3.307 | `3816c5a05cbf08fc090ad129c1c70f8b77627eca28f4ef673f6b2e8713447aab` |
| `shipment-jobs.csv` | 0 | 97 | `74f99ba02ef7329de86d54a879b951a64d1ed1c045ddeff66e87220c8a44f302` |
| `notifications-metadata.csv` | 67 | 8.920 | `0a9f8b7fd77695e0b764d445e0b7e62b4366a8e02666a855ff285491e97299a5` |
| `affiliate-payouts-preserved.csv` | 5 | 514 | `124b5bbdf6f5a59274db82d3a007a4ca639c082f4c25ad4261f0b8836917e32c` |
| `dry-run.json` | — | — | hasil simulasi read-only |

Arsip memuat referensi pembayaran, refund, conversion, shipment, metadata notification, dan payout yang dipertahankan. Tidak memuat nama/telepon/alamat pelanggan. File bukti refund/payout di disk **tidak disentuh**.

---

## 5. Dry-Run

Script: `scripts/order-cleanup/phase-2-cleanup.ts` (default dry-run, read-only).

| Item | Nilai |
|---|---|
| Mode | dry-run |
| Fingerprint | `d8bbf84cce6e7b9391681983897cac096f14697839c9b78b2b34b455dc17de1e` |
| Status | **BLOCKED** |
| Exit code | 2 |
| Kandidat total | **385** |

### 5.1 Kandidat hapus

| Tabel | Baris |
|---|---:|
| `order` | 163 |
| `orderitem` | 153 |
| `refund` | 6 |
| `affiliateconversion` | 17 |
| `notification` terkonfirmasi | 46 |
| `guestrecoverychallenge` | 0 |
| `shipmentjob` | 0 |
| **Total** | **385** |

Notification ambiguous: **21** (tidak masuk total; default dipertahankan sampai diputuskan manual).

### 5.2 Order terblokir

| Alasan | Order |
|---|---:|
| Hanya `refund` | 6 |
| Hanya `affiliateconversion` | 17 |
| Keduanya | 0 |
| **Total terblokir** | **23** |
| Order bersih (tanpa refund/conversion) | 140 |

Penghapusan parsial 140 order **tidak** dijalankan karena cakupan yang disetujui adalah seluruh histori, dan instruksi meminta berhenti bila ada blocker.

### 5.3 Preservation baseline (harus identik setelah eksekusi)

| Objek | Nilai |
|---|---:|
| `user` | 402 |
| `affiliateprofile` | 15 |
| `affiliatepayout` | 5 (total 151.450) |
| `product` | 28 (`sold` 100) |
| `productvariant` | 8 (stok 2.085) |
| `voucher` | 2 (`usedCount` 1) |
| `shippingdiscount` | 6 (`usedCount` 144) |
| `spinwheelspin` | 13 (0 terhubung order) |
| `adminauditlog` | 875 (387 `entityType='Order'`) |
| `voucheruserusage` | 1 |
| `flashsalepurchase` | 0 |

### 5.4 Notification

| Klasifikasi | Baris |
|---|---:|
| Terkonfirmasi terkait order (FK) | 46 |
| Ambiguous / manual review | 21 |
| Non-order | 0 |

21 ambiguous semuanya `ORDER_STATUS_CHANGED`; `idempotencyKey` memuat ID order yang sudah tidak ada. Tidak ada yang dihapus otomatis.

---

## 6. Gate Eksekusi Diuji — Ditolak Sebelum Transaksi

Percobaan `--execute` dengan token konfirmasi, backup, arsip, fingerprint, dan token verifikasi eksternal **tetap ditolak**:

```
{"mode":"execute","status":"BLOCKED","error":"BLOCKED: refund_open=2, payout_open=4, open_cod=18, whatsapp_tables_missing"}
exit 2
```

- Penolakan terjadi **sebelum** `prisma.$transaction`.
- Tidak ada baris yang dihapus/diubah.
- Token verifikasi eksternal pada uji gate hanya untuk menguji urutan gate; **tidak ada verifikasi eksternal yang benar-benar dilakukan**, sehingga token itu tidak boleh dianggap bukti.

---

## 7. Blocker yang Menyebabkan HALT

| ID | Blocker | Bukti | Dampak | Status |
|---|---|---|---|---|
| B1 | Refund terbuka | 1 PENDING (59.500), 1 PROCESSING (34.000) | Kewajiban finansial belum selesai; FK `NO ACTION` menolak hapus order | **BLOCKING** |
| B2 | Payout terbuka | 3 PENDING (96.000), 1 PROCESSING (52.450); 3 affiliate | Conversion adalah dasar `earned`; menghapusnya memutus rekonsiliasi payout | **BLOCKING** |
| B3 | COD terbuka | 18 order COD belum CANCELLED/COMPLETED | Penagihan dapat berjalan tanpa order lokal | **BLOCKING** |
| B4 | Tracking belum terverifikasi | 11 `trackingNumber`, 0 `providerShipmentId` | Status shipment eksternal tidak diketahui | **BLOCKING** (perlu verifikasi manual) |
| B5 | WhatsApp tidak terverifikasi | 2 tabel tidak ada; migration belum diterapkan | Referensi `verifiedOrderId` tidak bisa diaudit | **BLOCKING** (drift) |
| B6 | Production belum diaudit | Hanya DB dev `toko` | Schema/data production bisa berbeda | **BLOCKING** untuk production |
| B7 | Bukti refund tidak ada | 0/6 `proofFilePath`, 0 file ditemukan | Referensi bukti hilang bila baris refund dihapus | Perlu keputusan/arsip |
| B8 | Webhook pembayaran | 124 `paymentReference`, 38 PAID; kode mengembalikan 200 untuk order hilang | Pembayaran telat tidak terekonsiliasi | Perlu runbook/window |
| B9 | Window pembayaran aktif | 0 di dev | Aman di dev, belum tentu production | Verifikasi production |

Catatan: `providerShipmentId = 0` dan `shipmentjob = 0` **bukan** bukti tidak ada shipment; 11 resi dan 18 COD terbuka tetap menjadi blocker sampai diverifikasi manual.

---

## 8. Jumlah Record per Tabel (DB dev, sebelum dan sesudah — identik)

| Tabel | Baris | Tabel | Baris |
|---|---:|---|---:|
| `account` | 4 | `adminauditlog` | 875 |
| `affiliateclick` | 7 | `affiliateconversion` | 17 |
| `affiliatekyc` | 2 | `affiliatepayout` | 5 |
| `affiliateprofile` | 15 | `broadcast` | 5 |
| `bulkdiscount` | 2 | `campaign` | 1 |
| `campaigncategory` | 0 | `campaignproduct` | 0 |
| `cart` | 7 | `cartitem` | 4 |
| `district` | 1.811 | `flashsale` | 2 |
| `flashsalepurchase` | 0 | `guestrecoverychallenge` | 0 |
| `notification` | 67 | `order` | 163 |
| `orderitem` | 153 | `product` | 28 |
| `productdiscount` | 1 | `productvariant` | 8 |
| `promotion` | 0 | `province` | 54 |
| `rajaongkirregion` | 0 | `refund` | 6 |
| `regency` | 1.003 | `session` | 0 |
| `shipmentjob` | 0 | `shippingdiscount` | 6 |
| `spinwheelcampaign` | 1 | `spinwheelreward` | 7 |
| `spinwheelspin` | 13 | `storesetting` | 1 |
| `user` | 402 | `useraddress` | 15 |
| `verificationtoken` | 0 | `village` | 1.178 |
| `voucher` | 2 | `vouchercategory` | 0 |
| `voucherproduct` | 0 | `voucheruserusage` | 1 |
| `_prisma_migrations` | 29 | | |

Verifikasi akhir setelah seluruh percobaan: `order` 163, `orderitem` 153, `refund` 6, `affiliateconversion` 17, `notification` 67, `shipmentjob` 0, `guestrecoverychallenge` 0, `spinwheelspin` 13, `adminauditlog` 875, `affiliatepayout` 5, `productvariant` 8, stok 2.085, `user` 402.

---

## 9. Script Cleanup yang Disiapkan (belum dieksekusi)

| Item | Nilai |
|---|---|
| Path | `scripts/order-cleanup/phase-2-cleanup.ts` |
| Default | dry-run, read-only |
| Eksekusi | hanya dengan `--execute` + seluruh gate |
| Typecheck | `npx tsc --noEmit` → exit 0 |
| Dry-run teruji | exit 2, status BLOCKED |
| Gate eksekusi teruji | exit 2, ditolak sebelum transaksi |
| Target | lokal saja (`127.0.0.1`/`localhost`/`::1`) |

Gate eksekusi:
1. Token `--confirm=DELETE-ALL-ORDER-HISTORY`.
2. `--backup=<file>` ada, > 1 KB, header gzip valid.
3. `--archive=<dir>` ada.
4. `--fingerprint` sama dengan dry-run.
5. `--external-verified=NO_ACTIVE_SHIPMENTS` (asersi manusia; bukan pengganti verifikasi).
6. Tidak ada refund PENDING/PROCESSING, payout PENDING/PROCESSING, window pembayaran aktif, `providerShipmentId`, COD terbuka, shipment job, tabel WhatsApp hilang, atau tracking yang belum diverifikasi.

Perilaku eksekusi (jika semua gate lulus):
- Satu transaksi InnoDB; error/post-check gagal = rollback.
- Urutan: `guestrecoverychallenge` → `shipmentjob` → `orderitem` → `refund` → `affiliateconversion` → notification terhubung (+ ambiguous hanya dengan flag) → `order`.
- `spinwheelspin` tidak dihapus; hanya `orderId` menjadi NULL oleh FK `SET NULL`.
- Tidak menghapus/mengubah user, affiliate, payout, product, varian, stok, voucher, shipping discount, counter, audit, atau file.
- Tidak menonaktifkan foreign key checks; tidak ada TRUNCATE/DROP.

Penggunaan (untuk fase berikutnya, bukan sekarang):

```bash
npx tsx --env-file=.env scripts/order-cleanup/phase-2-cleanup.ts --dry-run

npx tsx --env-file=.env scripts/order-cleanup/phase-2-cleanup.ts --execute \
  --confirm=DELETE-ALL-ORDER-HISTORY \
  --backup=<verified-dump.sql.gz> \
  --archive=<archive-dir> \
  --fingerprint=<dari-dry-run> \
  --external-verified=NO_ACTIVE_SHIPMENTS
```

---

## 10. Mengapa DELETE Tidak Dijalankan

1. **Refund belum selesai** — instruksi melarang menghapus kewajiban refund yang belum selesai. FK `NO ACTION` juga akan menolak order terkait.
2. **Payout belum selesai** — 4 payout PENDING/PROCESSING; menghapus conversion menghilangkan dasar perhitungan komisi.
3. **COD/shipment belum tervalidasi** — 18 COD terbuka, 11 resi; tidak ada API call yang diizinkan/dilakukan.
4. **WhatsApp tidak bisa diverifikasi** — tabel state belum ada di DB dev.
5. **Production belum diaudit** — perubahan production dilarang sebelum verifikasi aman.
6. Menghapus hanya 140 order "bersih" akan melanggar cakupan "seluruh histori" dan tetap meninggalkan 23 order serta kewajiban finansial.

**Tidak ada `DELETE` yang dijalankan. Tidak ada data yang berubah.**

---

## 11. Konfirmasi Preservation

| Kewajiban | Status |
|---|---|
| User & akun affiliate | Utuh (402 / 15) |
| AffiliatePayout | Utuh (5; status & nominal tidak berubah) |
| Product & ProductVariant | Utuh (28 / 8) |
| Stok | 2.085, tidak direstock |
| Voucher & ShippingDiscount + counter | Utuh (usedCount 1 / 144) |
| SpinWheelSpin | 13, tidak dihapus |
| AdminAuditLog | 875, tidak diubah |
| Master lain | Tidak berubah |
| File bukti refund/payout | Tidak dihapus/dipindahkan |

---

## 12. Batasan dan Langkah Berikutnya

- Laporan ini hanya mengaudit DB dev lokal; **production belum diverifikasi dan tidak diubah**.
- Status shipment/pembayaran eksternal tidak diketahui karena tidak ada panggilan API.
- 21 notification ambiguous dipertahankan; belum ada penghapusan otomatis.

Untuk membuka jalan eksekusi (bukan pertanyaan cakupan):
1. Selesaikan 2 refund terbuka dan 4 payout terbuka, atau berikan keputusan finansial tertulis.
2. Verifikasi manual di Mengantar: tidak ada shipment/pickup/COD aktif untuk 11 resi dan 18 COD.
3. Terapkan/verifikasi state WhatsApp di production dan audit `verifiedOrderId`.
4. Audit production dengan query read-only; pastikan 7 FK dan kondisi data sama.
5. Pastikan tidak ada window pembayaran aktif dan settlement terakhir sudah masuk.
6. Baru kemudian jalankan dry-run sampai `READY`, lalu eksekusi dalam maintenance window.

## 13. Kesimpulan

**NO-GO untuk eksekusi saat ini.** Seluruh persiapan aman (verifikasi, backup+restore, arsip, script, dry-run) selesai, tetapi blocker finansial dan eksternal masih ada. Script siap dipakai setelah blocker ditutup; sampai saat itu tidak ada `DELETE` yang boleh dijalankan.

**Status akhir: HALTED BEFORE DELETE — 0 baris dihapus, 0 baris diubah.**
