# FINAL CLEANUP RESULT

## Order History Cleanup — Local/Dev `toko`

| Item | Nilai |
|---|---|
| Tanggal | 2026-10-19 |
| Target | DB lokal/dev `toko` — MariaDB 11.8.8 (`127.0.0.1`, host `webdev`) |
| Production | Tidak diakses / tidak diubah |
| Mode | `--scope=safe` (hanya record yang terbukti aman) |
| Status akhir | **PARTIALLY COMPLETED** |
| Foreign key checks dinonaktifkan | Tidak |
| Status refund / payout / COD / shipment diubah | **Tidak** |
| Panggilan API eksternal | Tidak ada |
| Migration | Tidak ada |

---

## 1. Executive Summary

Cleanup subset aman **berhasil dijalankan** pada database lokal `toko`:

- **113 dari 163 order dihapus** beserta turunannya.
- **50 order dipertahankan** karena masih terikat kewajiban finansial atau pengiriman nyata yang belum selesai.
- Seluruh data master, stok, counter, payout, spin, dan audit log **tetap utuh**.
- Tidak ada orphan row dan tidak ada FK violation (56 FK tetap ada).
- Re-run aman: eksekusi ulang menghasilkan `NOTHING_SAFE_TO_DELETE` (idempoten).

Record yang dihapus:

| Tabel | Dihapus |
|---|---:|
| `order` | 113 |
| `orderitem` | 117 |
| `refund` | 4 (refund yang sudah COMPLETED) |
| `affiliateconversion` | 0 (semuanya terikat order/payout yang masih terbuka) |
| `notification` (terkait order) | 29 |
| `notification` (orphan order) | 21 |
| `guestrecoverychallenge` | 0 |
| `shipmentjob` | 0 |

Record yang **tidak** dihapus (50 order): 2 order dengan refund terbuka, 11 dengan liabilitas komisi/payout, 18 COD terbuka, 11 dengan resi/tracking, 20 dengan pembayaran online yang belum dapat dipastikan selesai (angka saling tumpang tindih; totalnya 50 order unik).

---

## 2. Verifikasi Target

| Pemeriksaan | Hasil |
|---|---|
| Host | `127.0.0.1` / `webdev` (lokal) |
| Database | `toko` |
| Validasi script | Menolak eksekusi bila host bukan lokal atau DB bukan `toko` |
| Tabel | 45, seluruhnya InnoDB |
| Foreign key | 56 (7 menunjuk `order`) |
| Production | Tidak tersentuh |

---

## 3. Backup dan Uji Restore (sebelum eksekusi)

| Item | Nilai |
|---|---|
| Backup pre-delete | `/home/reksa/order-cleanup-backups/toko-2026-10-19T04-23-54-025Z.sql.gz` |
| Ukuran | 115.881 byte |
| SHA-256 | `bdccfb502f43ecd2eb6233c295710e70d01e236c65ac8109a13906b459870f55` |
| Gzip test | Lulus |
| Uji restore | DB disposable `toko_restore_verify_20261019042354` |
| Tabel direstore | 45 — **0 mismatch** |
| FK setelah restore | 56 |
| DB uji | Dihapus setelah verifikasi |

Backup sebelumnya (`toko-2026-10-19T04-12-18-650Z`, `toko-2026-10-19T04-00-44-629Z`) juga masih tersimpan.

---

## 4. Kriteria "Aman" (yang dieksekusi) vs "Diblokir" (yang dipertahankan)

Order hanya dihapus bila **tidak** memenuhi satu pun kondisi berikut:

| Kondisi | Arti |
|---|---|
| `refund` status PENDING / PROCESSING | kewajiban pengembalian dana belum selesai |
| `affiliateconversion` status PENDING / APPROVED, atau affiliate-nya punya payout PENDING / PROCESSING | komisi/liabilitas belum diselesaikan |
| COD dengan status selain CANCELLED / COMPLETED | penagihan berjalan |
| `trackingNumber` atau `providerShipmentId` terisi | pengiriman nyata |
| Ada `shipmentjob` | outbox shipment aktif |
| Pembayaran online (bukan COD) UNPAID/PENDING dengan expiry di masa depan atau tanpa expiry | pembayaran belum final dan tidak dapat dipastikan tertutup |

Order yang aman: cancel/failed, pembayaran settled (PAID) tanpa kewajiban, pembayaran pending yang window-nya sudah kedaluwarsa, refund yang sudah COMPLETED, dan COD yang sudah selesai/cancelled.

---

## 5. Hasil Eksekusi (satu transaksi InnoDB)

```
scope        : safe
fingerprint  : e28b589c056aab6fe27d3112270a2d3dbdc1e524b8e1104d2464f8ef9fa79747
status       : COMMITTED
deleted      : order 113, orderitem 117, refund 4, affiliateconversion 0,
               notification(linked) 29, notification(orphan) 21,
               guestrecoverychallenge 0, shipmentjob 0
after        : order 50, orderitem 36, refund 2, affiliateconversion 17,
               notification 17, guestrecoverychallenge 0, shipmentjob 0
```

Verifikasi di dalam transaksi sebelum commit:
- Safe-set dihitung ulang di dalam transaksi; bila berubah, seluruh transaksi ditolak.
- Jumlah baris setelah hapus harus sama dengan `sebelum - dihapus`.
- Tidak boleh ada orphan row.
- Preservation baseline harus identik.

Semua kondisi terpenuhi, transaksi di-commit.

---

## 6. Jumlah Record Sebelum / Sesudah

| Tabel | Sebelum | Sesudah | Selisih |
|---|---:|---:|---:|
| `order` | 163 | 50 | -113 |
| `orderitem` | 153 | 36 | -117 |
| `refund` | 6 | 2 | -4 |
| `affiliateconversion` | 17 | 17 | 0 |
| `notification` | 67 | 17 | -50 |
| `guestrecoverychallenge` | 0 | 0 | 0 |
| `shipmentjob` | 0 | 0 | 0 |
| `user` | 402 | 402 | 0 |
| `affiliateprofile` | 15 | 15 | 0 |
| `affiliatepayout` | 5 | 5 | 0 |
| `product` | 28 | 28 | 0 |
| `productvariant` | 8 | 8 | 0 |
| `spinwheelspin` | 13 | 13 | 0 |
| `adminauditlog` | 875 | 875 | 0 |
| `voucher` | 2 | 2 | 0 |
| `shippingdiscount` | 6 | 6 | 0 |
| `voucheruserusage` | 1 | 1 | 0 |
| `flashsalepurchase` | 0 | 0 | 0 |
| `cart` / `cartitem` | 7 / 4 | 7 / 4 | 0 |
| `useraddress` | 15 | 15 | 0 |
| `storesetting` | 1 | 1 | 0 |
| `_prisma_migrations` | 29 | 29 | 0 |
| Tabel master lain | tidak berubah | tidak berubah | 0 |

Hanya 4 tabel yang berubah: `order`, `orderitem`, `refund`, `notification`. Seluruh 41 tabel lain identik dengan baseline.

---

## 7. Preservation Verification (sesudah eksekusi)

| Kewajiban | Hasil |
|---|---|
| User | 402 — utuh |
| Akun affiliate | 15 — utuh |
| AffiliatePayout | 5 baris, total 151.450 — utuh, status/nominal tidak berubah |
| Product / ProductVariant | 28 / 8 — utuh |
| Stok | 2.085 — identik, tanpa restock |
| Voucher & counter | 2 baris, `usedCount` 1 — identik |
| ShippingDiscount & counter | 6 baris, `usedCount` 144 — identik |
| SpinWheelSpin | 13 — utuh, tanpa orphan |
| AdminAuditLog | 875 — utuh |
| `voucheruserusage` / `flashsalepurchase` | 1 / 0 — utuh |
| File bukti refund/payout | Tidak disentuh |
| FK violation / orphan | 0 orphan di `orderitem`, `refund`, `affiliateconversion`, `notification`, `guestrecoverychallenge`, `shipmentjob`, `spinwheelspin` |
| Foreign key | 56 — utuh |
| Idempotensi | Eksekusi ulang: `NOTHING_SAFE_TO_DELETE` (exit 0), tidak ada perubahan |

---

## 8. Record yang Belum Dapat Dihapus (50 order)

Daftar lengkap: `/home/reksa/order-cleanup-archives/exec-20261019T042408Z/remaining-blocked-orders.csv` (50 baris + header, berisi `id`, `orderNumber`, `reasons`).

Ringkasan alasan (satu order bisa punya lebih dari satu alasan):

| Alasan | Order |
|---|---:|
| `refund_open` | 2 |
| `conversion_liability` | 11 |
| `cod_open` | 18 |
| `tracking` | 11 |
| `payment_unverified` | 20 |
| `provider_shipment` | 0 |
| `shipment_job` | 0 |
| **Total order unik** | **50** |

Kewajiban terbuka yang masih tersimpan:

| Kewajiban | Jumlah |
|---|---:|
| Refund PENDING/PROCESSING | 2 (total Rp 93.500) |
| Payout PENDING/PROCESSING | 4 (total Rp 148.450) |
| Commission PENDING/APPROVED | 10 |
| COD belum selesai | 18 |
| Resi/tracking | 11 |
| Window pembayaran aktif (`paymentExpiresAt > NOW()`) | 0 |
| Provider shipment id | 0 |
| ShipmentJob | 0 |

Tidak ada status refund, payout, COD, atau shipment yang diubah untuk "meloloskan" penghapusan.

---

## 9. Perubahan Source Code

| File | Perubahan |
|---|---|
| `scripts/order-cleanup/phase-2-cleanup.ts` | Ditambah `--scope=safe`: predikat safe per order, pemetaan alasan blokir, penghapusan child hanya untuk order aman, re-verifikasi safe-set di dalam transaksi, post-check jumlah/orphan/preservation, penulisan `remaining-blocked-orders.csv`, dan idempotensi. Scope `all` tetap ada dengan gate lengkap (masih BLOCKED). |
| `lib/payment/webhook-trace.ts` | Jejak audit untuk webhook pembayaran order yang sudah dihapus (dipertahankan sebagai rekonsiliasi). |
| `lib/admin/audit-log.ts` | Action `PAYMENT_WEBHOOK_ORPHAN`. |
| Route webhook iPaymu & Midtrans | Memanggil jejak audit saat order tidak ditemukan; tetap balas 200, tidak membuat status pembayaran. |
| `__tests__/security/payment-webhook-orphan-trace.test.ts` | 5 tes regresi. |

Dokumen `PHASE-1-IMPACT-ANALYSIS.md`, `PHASE-2-CLEANUP-EXECUTION.md`, dan `FINAL-ORDER-CLEANUP-REPORT.md` tidak diubah.

---

## 10. Pengujian

| Uji | Hasil |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| `eslint scripts/order-cleanup/phase-2-cleanup.ts` | PASS (0 error, 0 warning) |
| Jest (5 suite: webhook hardening, refund-repay, affiliate payout, audit logging, webhook orphan trace) | PASS — 177 tes |
| Dry-run `--scope=safe` sebelum eksekusi | READY — 113 safe, 50 blocked |
| Eksekusi `--scope=safe` | COMMITTED — 113 order dihapus |
| Dry-run & execute ulang | `NOTHING_SAFE_TO_DELETE` (idempoten) |
| Post-cleanup verification | Orphan 0, FK 56, preservation identik |

---

## 11. Batasan

- Production tidak diaudit dan tidak diubah; hasil ini hanya untuk database lokal `toko`.
- Verifikasi status eksternal (Mengantar/COD/pembayaran) tidak dapat dilakukan dari environment ini; karena itu 50 order tetap dipertahankan.
- Jalur `--scope=all` tetap BLOCKED selama kewajiban terbuka masih ada.
- 17 AffiliateConversion tetap ada karena seluruh order terkait termasuk blocked.

## 12. Status Akhir

**PARTIALLY COMPLETED.**

- 113 order history aman berhasil dihapus dalam satu transaksi dengan rollback terjamin.
- 50 order beserta 2 refund, 17 conversion, 4 payout, 18 COD, dan 11 resi tetap dipertahankan karena kewajiban finansial/pengiriman belum selesai.
- Tidak ada data master, stok, counter, payout, spin, audit, atau file bukti yang berubah.
