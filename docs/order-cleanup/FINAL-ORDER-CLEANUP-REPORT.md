# FINAL ORDER CLEANUP REPORT

## End-to-End Workflow — Local/Dev `toko`

| Item | Nilai |
|---|---|
| Tanggal | 2026-10-19 |
| Target | DB lokal/dev `toko` — MariaDB 11.8.8 (`127.0.0.1`, host `webdev`) |
| Production | **Tidak diakses / tidak diubah** |
| Migration dijalankan | Tidak |
| `DELETE` dijalankan | **0** |
| `UPDATE`/`ALTER`/`DROP`/`TRUNCATE` pada data | 0 |
| Foreign key checks dinonaktifkan | Tidak |
| Panggilan API eksternal | Tidak ada |
| Laporan Phase 1 / Phase 2 | Tidak diubah |

---

## 1. Executive Summary

Seluruh pekerjaan teknis selesai: audit blocker, perbaikan script cleanup, perbaikan kode aplikasi untuk konsistensi pasca-cleanup, typecheck, pengujian, backup, uji restore, preservation snapshot, dan dry-run.

Namun **`DELETE` tidak dijalankan** karena safety gate tidak pernah READY:

| Blocker | Jumlah |
|---|---:|
| Refund terbuka (PENDING/PROCESSING) | 2 |
| Payout terbuka (PENDING/PROCESSING) | 4 |
| COD belum selesai | 18 |
| Resi belum terverifikasi eksternal | 11 |
| Tabel WhatsApp di DB dev | tidak ada (2 dari 2 hilang) |

Sesuai instruksi: tidak ada penyelesaian yang dipalsukan, tidak ada status provider yang dikarang, tidak ada safety gate yang dinonaktifkan, dan tidak ada `DELETE` terhadap data yang masih terblokir.

**Status akhir: BLOCKED** — pekerjaan teknis COMPLETED, eksekusi data tidak dijalankan.

---

## 2. Perubahan Source Code

| File | Perubahan |
|---|---|
| `scripts/order-cleanup/phase-2-cleanup.ts` | Diperkuat: idempotent (`ALREADY_CLEAN`), validasi target wajib lokal + DB `toko`, re-check blocker **di dalam transaksi**, pembersihan binding `whatsapp_chat_state` (kolom referensi saja), penghapusan notification terkait order termasuk 21 orphan terverifikasi (dengan opt-out `--keep-orphan-notifications`), preservation snapshot sebelum/sesudah, gate backup/arsip/fingerprint, satu transaksi InnoDB dengan rollback otomatis, tanpa menonaktifkan FK, tanpa menyentuh stok/counter/payout/audit/file |
| `lib/admin/audit-log.ts` | Tambah `AuditAction` `PAYMENT_WEBHOOK_ORPHAN` |
| `lib/payment/webhook-trace.ts` | **Baru** — helper `recordUnmatchedPaymentWebhook()`; menulis jejak ke `AdminAuditLog` (tabel yang dipertahankan), tanpa mengubah order/payment, tanpa PII |
| `app/api/payment/ipaymu/notification/route.ts` | Order tidak ditemukan → tulis jejak audit sebelum tetap membalas 200 |
| `app/api/payment/midtrans/notification/route.ts` | Sama seperti iPaymu |
| `__tests__/security/payment-webhook-orphan-trace.test.ts` | **Baru** — 5 tes regresi |

Tidak ada perubahan pada: schema/migration, model finansial, counter, stok, payout, audit lama, atau laporan sebelumnya.

---

## 3. Blocker yang Berhasil Diselesaikan (Teknis)

| Blocker | Penyelesaian |
|---|---|
| Webhook pembayaran telat tanpa jejak | Setiap callback untuk order yang tidak ada kini menulis `AdminAuditLog` (`PAYMENT_WEBHOOK_ORPHAN`) — permanen, karena audit log tidak dihapus |
| Referensi `verifiedOrderId` WhatsApp | Script membersihkan **hanya binding** (`verifiedOrderId`, `verifiedAt`, `pendingIntent`, state `VERIFIED_* → IDLE`) bila tabel ada; baris/histori WhatsApp tidak dihapus. Tabel belum ada di dev, jadi tidak ada referensi lokal yang hilang |
| Konsistensi saldo affiliate saat conversion dihapus | Gate keras menolak eksekusi bila ada payout PENDING/PROCESSING; saldo ter-clamp ke 0 tanpa dana hantu, dan payout tidak diubah. Dibuktikan tes regresi |
| Idempotensi cleanup | Re-run pada DB yang sudah bersih → `ALREADY_CLEAN` (exit 0), bukan kegagalan |
| Eksekusi parsial/nyasar | Validasi target wajib `127.0.0.1` **dan** DB `toko`; fingerprint berubah = eksekusi ditolak |
| Re-check race condition | Blocker diperiksa ulang di dalam transaksi yang sama dengan `DELETE` |
| Jejak sebelum perubahan | `preservation-before.json` dan `preservation-after.json` ditulis ke direktori arsip pada eksekusi (belum terjadi karena gate BLOCKED) |

---

## 4. Blocker Eksternal yang Tersisa

| ID | Blocker | Bukti | Mengapa tidak bisa diselesaikan dari environment ini |
|---|---|---|---|
| X1 | 2 refund terbuka | 1 PENDING Rp 59.500, 1 PROCESSING Rp 34.000 | Butuh aksi pengembalian dana nyata; dilarang memalsukan status |
| X2 | 4 payout terbuka | 3 PENDING Rp 96.000, 1 PROCESSING Rp 52.450 (3 affiliate) | Butuh keputusan/transfer admin; nominal & status tidak boleh diubah sepihak |
| X3 | 18 COD belum selesai | `paymentMethod='COD'`, status belum CANCELLED/COMPLETED | Status penagihan ada di Mengantar; API eksternal tidak dipanggil/diizinkan |
| X4 | 11 resi belum terverifikasi | `trackingNumber` terisi, `providerShipmentId` kosong | Tidak dapat membuktikan shipment selesai/tidak dari DB lokal |
| X5 | Tabel WhatsApp tidak ada di dev | `whatsapp_chat_state`, `whatsapp_inbound_message` = 0 | Drift migration lokal; production belum diaudit |
| X6 | Production belum diaudit | Hanya DB dev `toko` | Batas eksekusi sesi ini adalah database lokal |

Daftar rekonsiliasi untuk verifikasi manual ada di `unresolved-cod-tracking.csv` (29 baris) dan `payment-exposure.csv` (124 baris).

---

## 5. Backup dan Restore Verification

| Item | Nilai |
|---|---|
| Backup terbaru | `/home/reksa/order-cleanup-backups/toko-2026-10-19T04-12-18-650Z.sql.gz` |
| Ukuran | 115.881 byte |
| SHA-256 | `89dd2826be84eee00aab42c7646df254747d79d77aea7488af1354c31ee9dc8a` |
| Gzip test | Lulus |
| Restore DB uji | `toko_restore_verify_20261019041218` (disposable, dihapus setelah verifikasi) |
| Tabel direstore | 45 |
| Selisih baris | **0** (45/45 cocok) |
| FK setelah restore | 56 |
| `@@foreign_key_checks` setelah restore | 1 |
| Counter setelah restore | stok 2.085; `sold` 100; voucher 1; shipping discount 144; payout 151.450; audit 875; spin 13; user 402; product 28 |

Backup sebelumnya juga masih ada: `toko-2026-10-19T04-00-44-629Z.sql.gz` (`57bc09…b89e64`).

---

## 6. Hasil Dry-Run

Script: `scripts/order-cleanup/phase-2-cleanup.ts` (read-only).

```json
{
  "mode": "dry-run",
  "target": { "db": "toko", "host": "webdev", "version": "11.8.8-MariaDB", "fkCount": 56 },
  "fingerprint": "b87e4b015598f10fcd82b60c9c169de2f592588734ff2987fed93c9f6ea9a532",
  "counts": {
    "orders": 163, "orderitems": 153, "refunds": 6, "conversions": 17,
    "notificationsOrder": 46, "notificationsOrphan": 21,
    "guestRecovery": 0, "shipmentJobs": 0
  },
  "candidates": 385,
  "blockers": [
    "refund_open=2", "payout_open=4", "open_cod=18",
    "whatsapp_tables_missing", "tracking_unverified=11"
  ],
  "status": "BLOCKED"
}
```

Exit code 2. Kandidat 385 = 163 + 153 + 6 + 17 + 46 + 0 + 0. Notification orphan 21 tidak dihitung dalam kandidat tampilan, tetapi ikut dihapus secara default (semuanya `ORDER_STATUS_CHANGED` dengan referensi order yang sudah tidak ada; 0 notification non-order).

### 6.1 Uji gate eksekusi

| Percobaan | Hasil |
|---|---|
| `--execute` tanpa `--external-verified` | `BLOCKED: --external-verified token missing/wrong` (exit 2) |
| `--execute` lengkap dengan token | `BLOCKED: refund_open=2, payout_open=4, open_cod=18, whatsapp_tables_missing` (exit 2) |

Kedua percobaan ditolak **sebelum** `prisma.$transaction`. Tidak ada baris berubah. Token eksternal pada uji gate hanya menguji urutan gate; tidak ada verifikasi eksternal yang benar-benar dilakukan.

---

## 7. Jumlah Record Sebelum / Sesudah

Cleanup tidak dijalankan, sehingga angka sesudah = sebelum. Perbandingan ulang seluruh 45 tabel: **0 mismatch (IDENTICAL)**.

| Tabel | Sebelum | Sesudah |
|---|---:|---:|
| `order` | 163 | 163 |
| `orderitem` | 153 | 153 |
| `refund` | 6 | 6 |
| `affiliateconversion` | 17 | 17 |
| `notification` | 67 | 67 |
| `guestrecoverychallenge` | 0 | 0 |
| `shipmentjob` | 0 | 0 |
| `user` | 402 | 402 |
| `affiliateprofile` | 15 | 15 |
| `affiliatepayout` | 5 | 5 |
| `product` | 28 | 28 |
| `productvariant` | 8 | 8 |
| `spinwheelspin` | 13 | 13 |
| `adminauditlog` | 875 | 875 |
| `voucher` | 2 | 2 |
| `shippingdiscount` | 6 | 6 |
| `voucheruserusage` | 1 | 1 |
| `flashsalepurchase` | 0 | 0 |

Snapshot lengkap 45 tabel: `/home/reksa/order-cleanup-archives/final-2026-10-19T04-12-38-846Z/preservation-snapshot.json`.

---

## 8. Preservation Verification

| Kewajiban | Hasil |
|---|---|
| User | 402 — utuh |
| Akun affiliate | 15 — utuh |
| AffiliatePayout | 5 baris, nominal total 151.450, status tidak berubah |
| Product / ProductVariant | 28 / 8 — utuh |
| Stok | 2.085 — identik, tanpa restock |
| Voucher & counter | 2 baris, `usedCount` 1 — identik |
| ShippingDiscount & counter | 6 baris, `usedCount` 144 — identik |
| SpinWheelSpin | 13 — utuh |
| AdminAuditLog | 875 — utuh |
| `voucheruserusage` / `flashsalepurchase` | 1 / 0 — utuh |
| File bukti refund/payout | 0 path tercatat, 0 file disentuh |
| FK violation | Tidak ada (56 FK utuh) |
| Database lain | Tidak disentuh |

---

## 9. Hasil Pengujian

| Uji | Perintah | Hasil |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **PASS** (exit 0) |
| Jest | `webhook-hardening`, `refund-repay-webhook`, `affiliate-payout-transaction`, `m5-audit-logging`, `payment-webhook-orphan-trace` | **PASS** — 5 suite, **177 tes** |
| Dry-run script | `npx tsx scripts/order-cleanup/phase-2-cleanup.ts --dry-run` | BLOCKED (exit 2) — sesuai harapan |
| Gate eksekusi (2 skenario) | `--execute` tanpa/dengan token eksternal | BLOCKED (exit 2), tanpa transaksi |
| Restore backup | import ke DB disposable + banding 45 tabel | **PASS** — 0 mismatch |
| ESLint file terkait | `eslint` pada file yang diubah | 2 error + 1 warning **pre-existing** (terverifikasi sama pada `HEAD`); file baru bersih |

Batasan pengujian: jalur `--execute` yang sesungguhnya (transaksi, pembersihan binding WhatsApp, `ALREADY_CLEAN`) **tidak** diuji end-to-end karena gate selalu BLOCKED. Jalur tersebut diverifikasi lewat typecheck, dry-run, uji gate, dan review statis.

---

## 10. Arsip

Direktori final: `/home/reksa/order-cleanup-archives/final-2026-10-19T04-12-38-846Z/` (permission 700; file 600).

| File | Baris | SHA-256 |
|---|---:|---|
| `preservation-snapshot.json` | 45 tabel | `eddfa6d70ddf432503261b40d3dd0e4e7b8c149b3f989307dc12f37a4566d1a1` |
| `unresolved-cod-tracking.csv` | 29 | `63a37d2d91f8946563e258594de960b3dd73ca9734c1369e86276659bb3de7ae` |
| `payment-exposure.csv` | 124 | `eb31bce2930ed69acea8cc9e7ee4810d6c4a92ff22ff4cff6a979309cf57418c` |

Arsip Phase 2 sebelumnya tetap ada di `/home/reksa/order-cleanup-archives/phase2-2026-10-19T04-01-34-875Z/`.

---

## 11. Kesimpulan dan Status Akhir

- Semua pekerjaan teknis yang bisa diselesaikan tanpa memalsukan status finansial/provider **sudah selesai**.
- `DELETE` **tidak dijalankan** karena gate tidak READY; ini keputusan sengaja untuk mematuhi instruksi.
- Tidak ada perubahan data apa pun pada DB dev; production tidak disentuh.

**Status akhir: BLOCKED.**

Untuk membuka eksekusi: selesaikan 2 refund, 4 payout, verifikasi manual 18 COD + 11 resi di Mengantar, audit production dan tabel WhatsApp, lalu jalankan dry-run sampai `READY` dan eksekusi dengan gate lengkap.
