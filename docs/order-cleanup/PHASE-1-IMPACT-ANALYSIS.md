# PHASE 1 — FULL ORDER HISTORY CLEANUP

## Impact Analysis & Planning (READ-ONLY)

| Item | Nilai |
|---|---|
| Tanggal audit | 2026-10-19 |
| Status | **PLANNING ONLY — belum ada izin implementasi/eksekusi** |
| Database yang diverifikasi | DB lokal/dev `toko` — MariaDB 11.8.8 |
| Production | **BELUM diverifikasi** (lihat §8) |
| Metode | Baca schema + migration + source code, lalu `SELECT` read-only ke `information_schema` dan tabel data |
| Perubahan data | **Tidak ada** (`DELETE`/`UPDATE`/`ALTER`/`DROP`/`TRUNCATE` = 0) |
| Script cleanup lama | **Tidak dijalankan** (`scripts/order-cascade-cleanup.ts` hanya dibaca sebagai referensi) |
| File yang dibuat | Hanya laporan ini |

> Laporan audit lama (`ORDER-CASCADE-CLEANUP.md`, `docs/order-cascade-cleanup-dry-run.json`) **tidak diubah**.

---

## 1. Executive Summary

Audit menemukan **7 foreign key langsung** ke `order`, **tidak ada relasi FK tingkat dua**, dan **4 jalur referensi tanpa FK** yang tidak terlihat dari constraint. Dari 163 order di DB dev:

- **385 baris** menjadi kandidat penghapusan dalam scope yang dikonfirmasi (order 163, orderitem 153, refund 6, affiliateconversion 17, notification terkonfirmasi 46, shipmentjob 0, guestrecoverychallenge 0).
- **23 order terblokir** oleh `refund` (NO ACTION) dan/atau `affiliateconversion` (RESTRICT) dan **tidak bisa dihapus** tanpa lebih dulu menghapus riwayat finansial tersebut.
- **2 refund masih terbuka** (1 PENDING Rp 59.500, 1 PROCESSING Rp 34.000) — kewajiban finansial belum selesai.
- **3 affiliate memiliki payout reservasi** (PENDING Rp 96.000 + PROCESSING Rp 52.450). Menghapus conversion akan menghapus dasar perhitungan komisi, sementara payout wajib dipertahankan apa adanya.
- **21 notification** memiliki `orderId = NULL`, tetapi semuanya bertipe `ORDER_STATUS_CHANGED` dan `idempotencyKey`-nya memuat ID order yang **sudah tidak ada**. Tidak ada satu pun notification non-order. 21 baris ini masuk kategori **ambiguous/manual review**, bukan dihapus otomatis.
- **Data pembayaran hanya hidup di baris `order`** (tidak ada tabel `payment`). 124 order punya `paymentReference`, 38 berstatus `PAID`. Setelah order dihapus, bukti pembayaran hilang permanen.
- **Tidak ada shipmentjob/`providerShipmentId`** di dev, tetapi ada **11 resi** dan **18 COD belum selesai** — kondisi eksternal Mengantar **tidak bisa disimpulkan aman** dari DB lokal.
- **Tabel WhatsApp belum ada** di DB dev (migration `20261013120000` belum diterapkan), sehingga referensi `whatsapp_chat_state.verifiedOrderId` tidak bisa diaudit di dev.

**Kesimpulan:** rencana teknis layak dilanjutkan, tetapi **eksekusi belum aman**. Rekomendasi akhir: **CONDITIONAL GO untuk implementasi, NO-GO untuk eksekusi** sampai seluruh blocking issue di §8 ditutup.

---

## 2. Confirmed Cleanup Scope

### 2.1 Target penghapusan (dikonfirmasi user)

| Tabel | Baris (dev) | Catatan |
|---|---:|---|
| `order` | 163 | seluruh histori |
| `orderitem` | 153 | termasuk 24 item dengan `productId`/`variantId` NULL (snapshot) |
| `refund` | 6 | 1 PENDING, 1 PROCESSING, 4 COMPLETED |
| `affiliateconversion` | 17 | akun affiliate **tidak** dihapus |
| `notification` | 46 | hanya yang terkonfirmasi terkait order |
| `guestrecoverychallenge` | 0 | terkait order (CASCADE) |
| `shipmentjob` | 0 | hanya setelah validasi keamanan shipment |
| **Total** | **385** | +21 notification ambiguous jika nanti disetujui manual |

### 2.2 Wajib dipertahankan

| Objek | Baris (dev) | Komitmen |
|---|---:|---|
| `user` | 402 | tidak disentuh |
| `affiliateprofile` | 15 | tidak disentuh (hanya conversion yang dihapus) |
| `affiliatepayout` | 5 | status & nominal **tidak berubah** (PENDING 3 / PROCESSING 1 / REJECTED 1) |
| `product` | 28 | tidak disentuh |
| `productvariant` | 8 | **stok saat ini tidak diubah / tidak direstock** |
| `voucher` | 2 | `usedCount` saat ini (total 1) **tidak diubah** |
| `shippingdiscount` | 6 | `usedCount` saat ini (total 144) **tidak diubah** |
| `spinwheelspin` | 13 | dipertahankan; hanya `orderId` dapat menjadi NULL oleh FK |
| `adminauditlog` | 875 (387 `entityType='Order'`) | dipertahankan, termasuk yang menggantung |
| Master lain | cart, address, campaign, flashsale, store setting, region, dll. | tidak disentuh |
| File bukti refund/payout | lihat §3.3 | **tidak dihapus/dipindahkan** |

### 2.3 Non-goal (eksplisit)

- Tidak ada restock, perubahan `product.sold`, `voucher.usedCount`, `shippingdiscount.usedCount`, `voucheruserusage`, atau `flashsale.soldCount`.
- Tidak ada perubahan pada akun/komisi affiliate selain menghapus baris conversion.
- Tidak ada panggilan Mengantar, iPaymu/Midtrans, WhatsApp, atau TikTok.
- Tidak ada perubahan source code, migration, atau `db push`.

---

## 3. Dependency Matrix

### 3.1 FK langsung ke `order` (7 constraint, diverifikasi `information_schema`)

| No | Child → Parent | Kolom | FK | ON DELETE (Prisma / DB) | Baris dev | Aksi rencana | Efek |
|---|---|---|---|---|---:|---|---|
| 1 | `guestrecoverychallenge` → `order` | `orderId` | Ya | Cascade / CASCADE | 0 | DELETE lebih dulu | OTP hilang (disposable) |
| 2 | `shipmentjob` → `order` | `orderId` (unique) | Ya | Cascade / CASCADE | 0 | DELETE **hanya setelah** validasi shipment | Outbox/jejak retry hilang |
| 3 | `orderitem` → `order` | `orderId` | Ya | Cascade / CASCADE | 153 | DELETE lebih dulu | Snapshot item hilang |
| 4 | `refund` → `order` | `orderId` (unique) | Ya | Restrict / **NO ACTION** | 6 | DELETE setelah refund ditutup | Riwayat refund hilang, file di disk tetap |
| 5 | `affiliateconversion` → `order` | `orderId` (unique) | Ya | Restrict / **RESTRICT** | 17 | DELETE setelah keputusan payout | Dasar komisi hilang |
| 6 | `notification` → `order` | `orderId` | Ya | SetNull / SET NULL | 46 terhubung | DELETE hanya yang confirmed | 21 ambiguous dipertahankan |
| 7 | `spinwheelspin` → `order` | `orderId` (unique) | Ya | SetNull / SET NULL | 0 terhubung (dari 13) | **PRESERVE** | `orderId` menjadi NULL (implisit) |

**Tidak ada FK tingkat dua.** Dari 56 FK di DB dev, tidak ada tabel yang mereferensikan `orderitem`, `refund`, `shipmentjob`, `guestrecoverychallenge`, atau `spinwheelspin` (selain `order.originalSpinWheelSpinId` yang arahnya keluar). Jadi tidak ada cascade berantai di luar tabel di atas.

### 3.2 Relasi keluar dari `order` (parent tidak boleh ikut terhapus)

| Parent | Kolom di `order` | ON DELETE | Baris order memakai (dev) | Efek jika order dihapus |
|---|---|---|---:|---|
| `user` | `userId` | SET NULL | 163 (0 guest) | User aman |
| `voucher` | `voucherId` | SET NULL | 3 | Voucher aman; `usedCount` tetap |
| `shippingdiscount` | `shippingDiscountId` | SET NULL | 4 | Diskon aman; `usedCount` tetap |
| `spinwheelspin` | `originalSpinWheelSpinId` | SET NULL | 0 | Spin aman |

### 3.3 Relasi logis / counter / file (tanpa FK ke `order`)

| Objek | Bukti | Dampak jika order dihapus | Status rencana |
|---|---|---|---|
| `voucheruserusage` | 1 baris; `usageCount` per `ownerKey` | Kuota per-user tetap terpakai; tidak dikoreksi | Preserve (sesuai scope) |
| `product.sold` | total 100 | Laporan penjualan tetap; tidak dikoreksi | Preserve |
| `flashsale.soldCount` / `flashsalepurchase` | 0 / 0 | Tidak ada dampak di dev | Preserve |
| `affiliatepayout` | 5 baris, 3 affiliate dengan reservasi | Saldo `earned - disbursed` berubah karena `earned` hilang; payout tetap | Preserve nominal/status; conversion dihapus (**butuh persetujuan**) |
| `refund.proofFilePath` | 0 dari 6 baris punya path; 0 file ditemukan | Jika baris refund dihapus, referensi file hilang; file tidak boleh dihapus | Cek production sebelum eksekusi |
| `affiliatepayout.proofFilePath` | 0 dari 5 baris punya path | Tidak berubah | Preserve |
| `adminauditlog` | 387 baris `entityType='Order'`; **370 sudah menggantung** | Setelah cleanup, seluruh 387 menggantung | Preserve |
| `whatsapp_chat_state.verifiedOrderId` | Tabel **tidak ada** di dev | Binding chat bisa menunjuk order hilang | Cek production (blocking) |
| `notification` ambiguous | 21 baris `orderId IS NULL` | Tidak terhapus; payload berisi data order | Manual review |
| External provider refs | Mengantar: `providerShipmentId`/`batchId`/resi; payment: `paymentReference`/`paymentNo`/`qrString` | Referensi eksternal kehilangan padanan lokal | Lihat §5 |

### 3.4 Diagram

```text
order (163)
├── guestrecoverychallenge   orderId  CASCADE        0
├── shipmentjob              orderId  CASCADE        0
├── orderitem                orderId  CASCADE      153
├── refund                   orderId  NO ACTION      6  ⛔ memblokir
├── affiliateconversion      orderId  RESTRICT      17  ⛔ memblokir
├── notification             orderId  SET NULL     46  (+21 ambiguous)
└── spinwheelspin            orderId  SET NULL      0  (13 baris dipertahankan)

order → user (SET NULL), voucher, shippingdiscount, originalSpinWheelSpinId
Tanpa FK: adminauditlog(entityId), whatsapp_chat_state.verifiedOrderId,
          payload notification, referensi provider eksternal
```

---

## 4. Data Preservation Matrix

| Tabel | Kewajiban | Baris dev | Mekanisme yang bisa mengubah | Ekspektasi setelah cleanup | Verifikasi |
|---|---|---:|---|---|---|
| `user` | tetap | 402 | `order.userId` SET NULL (arah keluar) | 402, kolom tidak berubah | count sebelum/sesudah + checksum kolom kunci |
| `affiliateprofile` | tetap | 15 | tidak ada FK dari conversion ke profile yang cascade | 15, tidak berubah | count |
| `affiliatepayout` | status & nominal tetap | 5 | tidak ada FK ke order | 5; PENDING 3 (96.000), PROCESSING 1 (52.450), REJECTED 1 (3.000) | count + sum(amount) + status |
| `product` | tetap | 28 | `orderitem` FK ke product (arah keluar) | 28; `sold` tetap 100 | count + sum(sold) |
| `productvariant` | stok tetap | 8 | tidak ada update stok dari delete | 8; stok identik | count + sum(stock) |
| `voucher` | counter tetap | 2 | `order.voucherId` arah keluar | `usedCount` total tetap 1 | sum(usedCount) |
| `shippingdiscount` | counter tetap | 6 | `order.shippingDiscountId` arah keluar | `usedCount` total tetap 144 | sum(usedCount) |
| `spinwheelspin` | tetap | 13 | `orderId` SET NULL | 13 baris; hanya `orderId` berubah (saat ini 0 terhubung) | count + status + `orderId` |
| `adminauditlog` | tetap | 875 (387 Order) | tidak ada FK | 875; 387 menggantung | count + entityType |
| `voucheruserusage` | tetap | 1 | tidak ada | tidak berubah (drift existing tetap) | count + usageCount |
| Master lain | tetap | — | tidak ada relasi | tidak berubah | count per tabel |
| File `storage/uploads` | tidak dihapus | 0 refund path | tidak ada operasi file | identik | `find`/hash sebelum-sesudah |

Catatan: **stok tidak direstock** dan **counter tidak dikoreksi** adalah keputusan eksplisit. Konsekuensinya, laporan penjualan dan pemakaian voucher/ongkir akan tetap memuat transaksi yang sudah tidak ada.

---

## 5. External Transaction Risks

### 5.1 Pembayaran (iPaymu / Midtrans)

| Bukti lokal (dev) | Nilai |
|---|---:|
| Order `paymentStatus = PAID` | 38 |
| Order dengan `paymentReference` | 124 |
| Order dengan window pembayaran masih aktif (`paymentExpiresAt > NOW()`) | 0 |
| Order dengan `paymentExpiresAt` di masa depan (status apa pun) | 0 |
| Tabel `payment` terpisah | **tidak ada** |

Risiko:
1. **Tidak ada bukti pembayaran di luar `order`.** `paymentNo`, `paymentUrl`, `qrString`, `paymentReference`, `paidAt`, `paymentExpiresAt` hilang saat order dihapus.
2. **Webhook terlambat.** Kode `app/api/payment/ipaymu/notification/route.ts` dan `.../midtrans/notification/route.ts` mencari order lewat `orderNumber`. Jika tidak ditemukan, keduanya **mengembalikan HTTP 200** (`success:false`) agar provider berhenti retry. Artinya pembayaran yang masuk setelah order dihapus **tidak akan direkonsiliasi** dan tidak ada retry.
3. **VA/QRIS yang masih hidup** di sisi provider dapat dibayar kapan saja. Di dev tidak ada window aktif, tetapi production belum diperiksa.

Strategi sebelum eksekusi (tanpa memanggil API):
- Hentikan pembuatan order/VA/QRIS baru (maintenance intake).
- Tunggu melewati seluruh `paymentExpiresAt` terakhir + buffer settlement provider.
- Ekspor laporan settlement provider secara manual dan cocokkan dengan `paymentReference`/`orderNumber` sebelum penghapusan.
- Simpan arsip order (minimal nomor, tanggal, total, status, reference, `paidAt`) untuk rekonsiliasi pasca-hapus.
- Siapkan runbook untuk webhook yang masuk setelah cleanup: jangan menganggap 200 sebagai bukti aman.

### 5.2 Mengantar / shipment / COD

| Bukti lokal (dev) | Nilai |
|---|---:|
| `providerShipmentId` terisi | 0 |
| `trackingNumber` terisi | 11 |
| `shipmentStatus` / `shippingProvider` terisi | 0 / 0 (semua NULL) |
| `codAmount` terisi | 0 |
| Order COD | 24 (18 belum CANCELLED/COMPLETED) |
| `shipmentjob` | 0 |

Risiko:
- **0 shipmentjob bukan bukti tidak ada shipment.** Worker mungkin tidak berjalan di dev, dan 11 resi menunjukkan pengiriman pernah ada.
- Shipment/COD hidup di sistem Mengantar. Menghapus order menghapus satu-satunya padanan lokal (`providerShipmentId`, `batchId`, status, COD amount) tanpa membatalkan shipment (dan API tidak boleh dipanggil).
- COD yang masih berjalan dapat menagih uang tanpa order lokal.
- `ShipmentJob` CASCADE akan menghapus jejak retry/error.

Prasyarat: user memverifikasi manual di dashboard Mengantar bahwa **tidak ada shipment aktif, pickup terjadwal, atau COD outstanding** untuk order yang akan dihapus; worker shipment dihentikan selama window.

### 5.3 Affiliate & payout

| Status conversion | Baris | Nominal |
|---|---:|---:|
| PENDING | 1 | 2.500 |
| APPROVED | 9 | 172.450 |
| PAID | 2 | 10.000 |
| CANCELLED | 5 | 22.450 |

| Status payout | Baris | Nominal |
|---|---:|---:|
| PENDING | 3 | 96.000 |
| PROCESSING | 1 | 52.450 |
| REJECTED | 1 | 3.000 |

`getAvailableBalance()` menghitung `earned = SUM(conversion.status IN ('APPROVED','PAID'))` dan `available = max(0, earned - disbursed)`. Jika conversion dihapus:
- payout tetap ada (status/nominal tidak berubah), tetapi **`earned` menjadi 0** → saldo affiliate berubah drastis;
- 3 affiliate dengan payout reservasi kehilangan dasar perhitungan komisi;
- payout yang sudah PAID tidak lagi punya conversion pasangan (jejak audit finansial putus).

Ini **blocking finansial**, bukan sekadar teknis.

### 5.4 Refund

| Status | Baris | Nominal | Punya `proofFilePath` |
|---|---:|---:|---:|
| PENDING | 1 | 59.500 | 0 |
| PROCESSING | 1 | 34.000 | 0 |
| COMPLETED | 4 | 222.400 | 0 |

- **2 refund terbuka** = kewajiban belum selesai.
- Di dev, **tidak ada file bukti** yang tercatat maupun ditemukan di `storage/uploads`. Ini bisa berarti refund diselesaikan tanpa bukti, atau file tidak pernah diunggah. **Production harus diperiksa** sebelum baris refund dihapus.
- File tidak boleh dihapus; jika baris refund dihapus, path referensi hilang dan file menjadi yatim.

### 5.5 WhatsApp, TikTok, dan guest access

- **WhatsApp:** `whatsapp_chat_state` dan `whatsapp_inbound_message` **tidak ada di DB dev**; migration `20261013120000_whatsapp_autoreply_state` belum diterapkan. `verifiedOrderId` tidak bisa diaudit. Di production, binding chat bisa menunjuk order hilang. Pesan yang sudah terkirim tidak bisa ditarik.
- **TikTok:** 0 order memiliki `ttclid`/`ttp` di dev. Atribusi hanya tersimpan di `order`; event server-side yang sudah terkirim tidak bisa di-recall. Tidak ada risiko data lokal yang besar di dev, tetapi production perlu dihitung.
- **Guest access:** 0 guest order di dev (semua `userId` terisi). Di production, menghapus guest order akan membatalkan link/cookie akses guest; tidak ada mekanisme restore selain backup.

---

## 6. Proposed Cleanup Sequence (belum dieksekusi)

> Urutan ini untuk fase implementasi berikutnya. **Saat ini tidak dijalankan.**

1. **Freeze writers**
   - Maintenance window, hentikan worker shipment dan intake checkout/payment.
   - Pastikan tidak ada proses yang menulis `order`/`refund`/`conversion`/`notification`.
2. **Backup & verifikasi restore**
   - `mariadb-dump --single-transaction`, gzip, sha256, uji restore ke DB terpisah.
   - Jangan gunakan `prisma migrate deploy` untuk recovery (baseline migration tidak lengkap).
3. **Rekonsiliasi**
   - Refund: tutup PENDING/PROCESSING atau dapatkan keputusan eksplisit untuk membuangnya.
   - Affiliate: selesaikan/menolak payout dan setujui penghapusan dasar komisi.
   - Mengantar/COD: verifikasi manual tidak ada shipment/COD aktif.
   - Payment: pastikan tidak ada window/VA/QRIS aktif dan settlement terakhir sudah masuk.
4. **Arsip (opsional tetapi disarankan)**
   - Ekspor CSV/JSON order + item + refund + conversion + notification terpilih ke lokasi aman, untuk audit/pajak/rekonsiliasi.
   - Jangan menyertakan data sensitif ke repo.
5. **Delete anak → induk (satu transaksi InnoDB)**
   1. `guestrecoverychallenge` (orderId terkait)
   2. `shipmentjob` (hanya yang sudah tervalidasi)
   3. `orderitem`
   4. `refund`
   5. `affiliateconversion`
   6. `notification` (hanya 46 confirmed; 21 ambiguous **tidak**)
   7. `order`
   - `spinwheelspin` **tidak dihapus**; FK SET NULL akan mengubah `orderId` (saat ini 0 baris).
6. **Post-check (wajib)**
   - `order` dan seluruh child target = 0 (dalam scope).
   - Semua tabel preserve: count/sum identik dengan baseline.
   - Stok varian, `usedCount`, `product.sold`, payout (status+nominal), audit, spin (13 baris) diverifikasi.
   - Tidak ada orphan baru di luar yang sudah ada (audit 387, notif 21).
   - File di disk tidak berubah.
7. **Rollback plan**
   - Restore dari dump jika ada penyimpangan; transaksi dibatalkan bila gagal di tengah.

---

## 7. Dry-Run Design (rencana, belum dibuat/dijalankan)

Script baru (fase implementasi, **bukan sekarang**): `scripts/order-cleanup/phase-1-dry-run.ts`.

**Prinsip:**
- Hanya `SELECT`; koneksi di-set `SET SESSION TRANSACTION READ ONLY`.
- Tidak mengimpor modul jaringan, tidak memanggil API, tidak menulis DB.
- Tidak menjalankan `scripts/order-cascade-cleanup.ts`.
- Output JSON + ringkasan manusia; tidak mencetak PII (nomor telepon, alamat, nama, payload mentah).

**Yang dihitung:**
1. Fingerprint DB: nama DB, versi server, daftar tabel, FK ke `order`, migrasi applied, jumlah order, max(id).
2. Kandidat hapus per tabel dan total baris.
3. Order terblokir (`refund` ∪ `affiliateconversion`), beserta alasannya per order.
4. Notifikasi:
   - confirmed by FK;
   - confirmed by payload `orderNumber` yang cocok dengan order hidup;
   - ambiguous (payload/key tidak bisa dipastikan) → **tidak** masuk rencana hapus.
5. Refund: status, nominal, keberadaan `proofFilePath`, dan `fs.existsSync` (read-only).
6. Payout: status/nominal, affiliate terdampak, selisih `earned - disbursed` sebelum vs setelah simulasi.
7. Preservation baseline: count/sum seluruh tabel preserve.
8. Counter drift: `voucher.usedCount`, `shippingdiscount.usedCount`, `product.sold`, `voucheruserusage`, `flashsalepurchase`.
9. External preconditions: PAID, `paymentReference`, window aktif, `providerShipmentId`, resi, COD, `shipmentjob`, tabel WhatsApp.
10. Daftar gate yang belum terpenuhi.

**Exit code:** `0` = READY (dry-run), `2` = BLOCKED, `1` = error. Dry-run tidak pernah menulis.

**Output contoh (bentuk):**

```json
{
  "mode": "dry-run",
  "db": "toko",
  "fingerprint": "…",
  "candidates": { "order": 163, "orderitem": 153, "refund": 6, "affiliateconversion": 17, "notification": 46, "guestrecoverychallenge": 0, "shipmentjob": 0 },
  "blockedOrders": 23,
  "ambiguousNotifications": 21,
  "preserve": { "user": 402, "product": 28, "productvariant": 8, "voucher": 2, "shippingdiscount": 6, "spinwheelspin": 13, "adminauditlog": 875, "affiliatepayout": 5 },
  "gates": ["refund_open", "payout_unreconciled", "production_unverified", "backup_missing"],
  "status": "BLOCKED"
}
```

---

## 8. Blocking Issues

| ID | Blocker | Bukti | Dampak | Cara menutup |
|---|---|---|---|---|
| B1 | Production belum diaudit | Hanya DB dev `toko` yang bisa diakses | Schema/FK/data production bisa berbeda | Jalankan query §10 di VPS, lampirkan hasil |
| B2 | Refund terbuka | 2 baris (PENDING 59.500, PROCESSING 34.000) | Uang keluar tanpa jejak | Tutup refund atau setujui eksplisit untuk membuang |
| B3 | Bukti refund tidak ada | 0/6 `proofFilePath`; 0 file ditemukan | Tidak ada bukti transfer untuk audit | Cek production; jika ada file, arsipkan path sebelum hapus |
| B4 | Payout vs conversion | 3 affiliate, reservasi 148.450; 12 conversion aktif | Saldo & sengketa affiliate | Selesaikan payout; setujui penghapusan dasar komisi |
| B5 | Shipment/COD belum tervalidasi | 11 resi, 18 COD terbuka, 0 providerId, 0 job | Shipment/COD berjalan tanpa order lokal | Verifikasi manual Mengantar; hentikan worker |
| B6 | Webhook pembayaran | 124 `paymentReference`, 38 PAID; kode return 200 untuk order hilang | Pembayaran telat tidak terekonsiliasi | Freeze intake, tunggu expiry, ekspor settlement |
| B7 | WhatsApp state tidak ada di dev | Tabel & migration belum diterapkan | Binding chat production tidak diketahui | Cek production; putuskan reset binding setelah cleanup |
| B8 | 21 notification ambiguous | `orderId NULL`, key memuat ID order yang sudah tidak ada, payload `ORDER_STATUS_CHANGED` | Salah hapus = kehilangan jejak; dibiarkan = data yatim | Review manual; default **preserve** |
| B9 | Backup & window belum ada | Belum ada dump terverifikasi | Tidak ada rollback | Backup + uji restore + maintenance |
| B10 | Counter/stok akan stale | `voucher.usedCount` 1, `shippingDiscount` 144, `product.sold` 100 | Laporan & kuota tidak akurat | Diterima sebagai keputusan bisnis (scope) |
| B11 | Audit menggantung | 387 baris Order; 370 sudah menggantung | Audit menunjuk entitas hilang | Diterima / arsipkan laporan audit terpisah |
| B12 | Implementasi belum disetujui | — | Tidak boleh membuat/menjalankan script | Persetujuan terpisah setelah laporan ini |

---

## 9. Questions Requiring User Approval

1. **Order PAID & resi:** Setujui menghapus 38 order `PAID` dan 11 order dengan `trackingNumber`?
2. **Refund terbuka:** Apakah 2 refund (PENDING 59.500, PROCESSING 34.000) akan diselesaikan lebih dulu, atau dibuang bersama histori? (default: **tidak boleh** dihapus sebelum ditutup)
3. **Conversion vs payout:** Setujui penghapusan 17 conversion sementara 5 payout (3 affiliate, 148.450 reservasi) tetap utuh? Jika tidak, order terkait tidak bisa dihapus.
4. **Notification ambiguous:** 21 baris tanpa `orderId` — hapus setelah review manual, atau pertahankan?
5. **Production access:** Siapa yang menjalankan query §10 di VPS, dan kapan hasilnya tersedia?
6. **Backup/window:** Apakah sudah ada jadwal backup + maintenance, dan berapa lama retention?
7. **Mengantar/COD:** Siapa yang memverifikasi manual tidak ada shipment/COD aktif? (kita tidak boleh memanggil API)
8. **Kebijakan webhook pasca-hapus:** Jika pembayaran telat masuk, cukup dicatat/log dan di-200, atau perlu proses manual?
9. **Stok/counter:** Konfirmasi bahwa stok **tidak** direstock dan counter **tidak** dikoreksi (laporan akan tetap menyebut transaksi lama).
10. **Audit:** Konfirmasi 387 entri audit boleh menggantung tanpa entitas.
11. **Implementasi:** Apakah izin diberikan untuk membuat script dry-run baru (tetap read-only), terpisah dari izin eksekusi?

**Persetujuan rencana bukan persetujuan eksekusi.**

---

## 10. Final Recommendation

### **CONDITIONAL GO** untuk implementasi — **NO-GO** untuk eksekusi

Alasan:
- Struktur relasi sudah jelas dan urutan penghapusan dapat ditentukan dengan aman (7 FK, tanpa depth-2).
- Namun ada **kewajiban finansial terbuka** (refund 2, payout 3 affiliate), **bukti refund tidak tersedia**, **production belum diaudit**, **shipment/COD belum tervalidasi**, dan **webhook pembayaran dapat kehilangan rekonsiliasi**.

Syarat minimal sebelum status berubah menjadi GO eksekusi:
1. B1–B9 ditutup dengan bukti.
2. Backup terverifikasi + uji restore.
3. Persetujuan eksplisit atas penghapusan riwayat finansial (refund + conversion).
4. Keputusan tertulis untuk 21 notification ambiguous.
5. Maintenance window + worker/intake dihentikan.
6. Persetujuan implementasi dan eksekusi diberikan **terpisah**.

Jika user meminta eksekusi sebelum syarat di atas terpenuhi: **NO-GO**.

---

## Lampiran A — Bukti Read-Only (snapshot DB dev, 2026-10-19)

| Pemeriksaan | Hasil |
|---|---|
| Tabel | 45, semua InnoDB |
| Foreign key total | 56 |
| FK langsung ke `order` | 7 |
| Trigger / event / routine | 0 / 0 / 0 |
| Order | 163 (id 29–1819; 2026-08-13 s.d. 2026-09-28) |
| Order terblokir FK | 23 |
| Refund | 6 (PENDING 1 / PROCESSING 1 / COMPLETED 4), total 315.900 |
| Affiliate conversion | 17 (PENDING 1 / APPROVED 9 / PAID 2 / CANCELLED 5), total 207.400 |
| Affiliate payout | 5 (PENDING 3 / PROCESSING 1 / REJECTED 1) |
| Notification | 67; 46 terhubung; 21 `orderId NULL`; 0 non-order; SENT 10 / FAILED 57 |
| SpinWheelSpin | 13; 0 terhubung |
| AdminAuditLog Order | 387; 370 sudah menggantung |
| GuestRecoveryChallenge / ShipmentJob | 0 / 0 |
| Counter | voucher 1; shippingDiscount 144; product.sold 100; voucheruserusage 1; flashsalepurchase 0 |
| Master | user 402; affiliate 15; product 28; variant 8; voucher 2; shippingDiscount 6 |
| Schema drift dev | `whatsapp_chat_state`, `whatsapp_inbound_message` tidak ada; migration `20261013120000` belum diterapkan |
| `refund` ON DELETE | Prisma `Restrict`; DB `NO ACTION` (keduanya menolak delete) |

## Lampiran B — Query verifikasi production (read-only)

```sql
-- Jalankan sebagai user read-only, atau dalam START TRANSACTION READ ONLY; ... ROLLBACK;
SELECT k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME,
       r.DELETE_RULE, k.CONSTRAINT_NAME
FROM information_schema.KEY_COLUMN_USAGE k
JOIN information_schema.REFERENTIAL_CONSTRAINTS r
  ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA
 AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME='order';

SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME LIKE '%order%'
ORDER BY TABLE_NAME, COLUMN_NAME;

SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA=DATABASE()
  AND TABLE_NAME IN ('whatsapp_chat_state','whatsapp_inbound_message');

SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations ORDER BY finished_at;

SELECT COUNT(*) FROM `order`;
SELECT COUNT(*) FROM orderitem;
SELECT COUNT(*) FROM refund;
SELECT COUNT(*) FROM affiliateconversion;
SELECT COUNT(*) FROM notification WHERE orderId IS NOT NULL;
SELECT COUNT(*) FROM notification WHERE orderId IS NULL;
SELECT COUNT(*) FROM shipmentjob;
SELECT COUNT(*) FROM guestrecoverychallenge;
SELECT COUNT(*) FROM spinwheelspin WHERE orderId IS NOT NULL;
SELECT COUNT(*) FROM adminauditlog WHERE entityType='Order';

SELECT COUNT(DISTINCT o.id)
FROM `order` o
WHERE EXISTS (SELECT 1 FROM refund r WHERE r.orderId=o.id)
   OR EXISTS (SELECT 1 FROM affiliateconversion c WHERE c.orderId=o.id);
```

## Lampiran C — Batasan laporan ini

- Semua angka berasal dari DB dev `toko`; bukan production.
- Tidak ada panggilan API, sehingga status shipment/pembayaran eksternal tidak diketahui.
- Tidak ada pembacaan payload mentah ke laporan (hanya pola/agregat) untuk menghindari PII.
- Klasifikasi notifikasi dilakukan dengan `orderId` + `idempotencyKey` + `payload.orderNumber`; 21 baris ambiguous tidak diputuskan otomatis.
- Laporan ini **tidak** merupakan izin implementasi atau eksekusi.
