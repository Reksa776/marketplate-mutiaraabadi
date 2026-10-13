# AUDIT — Penghapusan Login Customer & Implementasi Guest Checkout

**Status:** READ-ONLY AUDIT. Tidak ada kode, migration, tabel, data, environment, atau deployment yang diubah.
**Basis:** source code aktual pada repositori (bukan asumsi).
**Tanggal:** 12 Oktober 2026

Stack terverifikasi dari `package.json` + kode:

| Komponen | Versi / Implementasi |
|---|---|
| Next.js | `^16.3.0` — **Middleware sudah bernama `proxy.ts`** (Next 16), file di root repo |
| React | `^19.2.8` |
| Prisma / DB | `^6.19.3`, `provider = "mysql"` (MariaDB/MySQL) |
| Auth | `next-auth@^5.0.0-beta.32` (Auth.js v5) + `@auth/prisma-adapter`, strategy **JWT** |
| Payment | iPaymu **Direct Payment** (bukan redirect) |
| Shipping | Mengantar (auto-shipment + webhook) dengan fallback RajaOngkir |
| State / cart | Server cart (Prisma) + cookie referral + sessionStorage (spin wheel) |

---

## A. Executive Summary

### Kondisi sistem saat ini

1. **Autentikasi customer dan autentikasi admin memakai satu sistem yang sama.**
   `auth.ts` mengekspor satu `NextAuth()` dengan dua provider: `Google` dan `Credentials`.
   `Credentials.authorize()` mencari `prisma.user.findFirst()` berdasarkan **email ATAU phone** — tanpa filter role.
   `components/auth/LoginForm.tsx` lalu **merutekan berdasarkan role**: `ADMIN → /admin`, selain itu `→ /home`.
   **Konsekuensi kritis: `/login`, provider Credentials, `auth.ts`, `AuthProvider`, dan seluruh `auth()` TIDAK BISA dihapus mentah-mentah.** Admin masih butuh jalur login itu.

2. **`Order.userId` WAJIB diisi (`String`, bukan nullable)** dan direlasikan dengan `onDelete: Cascade`.
   Guest order hari ini secara skema tidak mungkin dibuat, dan **menghapus baris `User` akan meng-CASCADE menghapus seluruh riwayat order** pelanggan tersebut (bersama `OrderItem`, `Notification`, `SpinWheelSpin`, `ShipmentJob`).

3. **Tidak ada identitas guest pada `Order`.** Tidak ada kolom `guestToken`, tidak ada `customerEmail`. Order identity untuk lookup pelanggan = kombinasi `Order.id` (auto-increment, mudah dienumerasi) + `userId` (dari session). Model ini tidak punya padanan untuk guest.

4. **Webhook payment & shipment SUDAH tidak bergantung pada session** — ini kabar baik:
   - `app/api/payment/ipaymu/notification/route.ts`: verifikasi signature → cari order via `orderNumber` (bukan session).
   - `app/api/mengantar/webhook/route.ts`: verifikasi HMAC → cari order via `providerShipmentId`/tracking.
   - Keduanya dikecualikan dari session guard di `proxy.ts` (`PUBLIC_API_PREFIXES`).

5. **Checkout server-authoritative sudah benar.** `lib/checkout.ts` (`createCheckoutOrder`) mengabaikan harga & ongkir dari client, memakai `verifyMengantarShippingCost()` / `verifyRajaOngkirShippingCostOrThrow()`, dan harga dari marketing engine. Menghapus login tidak boleh mengubah bagian ini.

### Tingkat kompleksitas

**TINGGI (High).** Ini bukan pekerjaan UI.

| Area | Beban perubahan |
|---|---|
| Skema Prisma & migration | Berat — `Order.userId`, `Cart`, `UserAddress`, `FlashSalePurchase`, `VoucherUserUsage`, `SpinWheelSpin`, `AffiliateProfile` semuanya terikat user |
| Address | Berat — satu-satunya input checkout adalah `addressId` yang di-query `where: { id, userId }` dari `UserAddress` |
| Cart | Sedang–Berat — `Cart.userId` **`@unique` wajib**; guest butuh cart anonim atau cart client |
| Order lookup & pembayaran guest | Sedang — butuh token/ownership baru untuk `/orders/[id]`, `/checkout/payment/[id]`, `/api/orders/[id]/payment-status` |
| Rate limiting | Sedang — semuanya di-key `userId`; `getClientIp()` mengembalikan `"untrusted"` bila `TRUSTED_PROXY` tidak di-set |
| Voucher / Spin Wheel / Flash Sale per-user | Sedang–Berat — semuanya bergantung `userId` |
| TikTok attribution | Ringan — `externalId: order.userId` perlu pengganti |
| Admin | **Nol** — asalkan admin tidak ikut dihapus (tapi ini bagian paling mudah salah) |

**Rekomendasi arsitektur tingkat tinggi:** jangan hapus `User`/NextAuth. Ubah target menjadi **"guest checkout opsional"** — customer tidak pernah *diwajibkan* login, tetapi tabel `User` tetap ada sebagai (a) identitas admin, (b) identitas affiliate, (c) arsip historis pelanggan lama.

---

## B. Authentication Dependency Map

### B.1 Server — inti auth

| File | Peran | Nasib saat guest checkout |
|---|---|---|
| `auth.ts` | `NextAuth()`: `PrismaAdapter`, `session.strategy="jwt"`, provider `Google` + `Credentials`, callbacks `signIn/jwt/session`, `pages.signIn="/login"` | **PERTAHANKAN** (dibutuhkan admin). Hapus provider `Google` bila login customer dihapus. |
| `app/api/auth/[...nextauth]/route.ts` | Re-export `handlers` | PERTAHANKAN |
| `app/api/auth/register/route.ts` | Registrasi customer: `hashPassword`, buat `User`, `referralCode`, validasi affiliate server-side | **HAPUS/redirect** setelah keputusan bisnis (lihat §J) |
| `lib/password.ts` | `hashPassword` / `verifyPassword` (bcrypt) | PERTAHANKAN (dipakai `scripts/admin-create.ts`) |
| `lib/validations/register.ts` | Skema zod registrasi | Hapus bersama register |
| `lib/services/auth.ts` | `register()` client → `/api/auth/register` | Hapus bersama register |
| `lib/auth.ts` | Konstanta `AUTH_ROUTES` (`LOGIN`, `REGISTER`, `PRODUCTS`, `ADMIN`, ...) | Perlu disesuaikan; `REGISTER` kemungkinan dihapus |
| `lib/admin.ts` | `requireAdmin()` → `auth()` + `role !== "ADMIN"` → FORBIDDEN | **PERTAHANKAN — jangan disentuh** |
| `lib/csrf.ts` | `requireSession()`, `requireAdminSession()` — **keduanya tidak dipanggil di mana pun** (dead code) | Kandidat hapus; tetapi lihat §F item CSRF |
| `proxy.ts` | Proxy (eks-`middleware.ts`) Next 16. `PUBLIC_API_PREFIXES`, `PROTECTED_API_PREFIXES`, `PROTECTED_PAGE_ROUTES`, `matcher` | Ubah daftar/route; JANGAN hapus guard `/admin` |

### B.2 Server — API yang memanggil `auth()` (customer-facing)

Semua di bawah ini **wajib disesuaikan** (auth dikeluarkan, diganti identitas guest):

```
app/api/cart/route.ts                    (GET/POST/PATCH/DELETE — 4x auth())
app/api/cart/[itemId]/route.ts           (2x)
app/api/checkout/route.ts                (GET data checkout)
app/api/buy-now/route.ts                 (GET + POST COD)
app/api/buy-now/ipaymu/route.ts
app/api/buy-now/shipping/route.ts
app/api/payment/ipaymu/route.ts          (POST non-COD)
app/api/payment/status/route.ts
app/api/orders/route.ts                  (POST COD + GET riwayat)
app/api/orders/[id]/route.ts             (detail)
app/api/orders/[id]/tracking/route.ts
app/api/orders/[id]/cancel/route.ts
app/api/orders/[id]/expire/route.ts
app/api/orders/[id]/payment-status/route.ts
app/api/orders/[id]/refund/route.ts
app/api/orders/[id]/repay/route.ts
app/api/profile/route.ts
app/api/address/route.ts                 (2x)
app/api/addresses/route.ts               (2x)
app/api/addresses/[id]/route.ts          (2x)
app/api/voucher/validate/route.ts
app/api/vouchers/available/route.ts
app/api/spin-wheel/route.ts
app/api/spin-wheel/spin/route.ts
app/api/spin-wheel/my-rewards/route.ts
app/api/analytics/tiktok-match/route.ts
app/api/mengantar/estimate/route.ts
app/api/uploads/affiliate/[...path]/route.ts
app/api/products/route.ts                (auth() hanya untuk flag `authenticated` → sembunyikan stok)
```

### B.3 Server — admin & affiliate (PERTAHANKAN)

- **~70 route** di `app/api/admin/**` menggunakan `requireAdmin()` / `auth()` + role check.
- `app/api/affiliate/{application,commissions,dashboard,payouts,upload}` — milik **AFFILIATOR**, bukan customer. Ini keputusan bisnis: apakah affilator tetap punya akun login?
- `app/admin/layout.tsx` — `auth()` → `redirect("/login")` → `role !== "ADMIN"` → `redirect("/products")`.

### B.4 Client / UI

| File | Ketergantungan |
|---|---|
| `components/providers/AuthProvider.tsx` | `<SessionProvider>` membungkus **seluruh app** di `app/layout.tsx` |
| `components/auth/LoginForm.tsx` | `signIn`, `getSession`; routing per-role (`ADMIN → /admin`) |
| `components/auth/RegisterForm.tsx` | registrasi customer |
| `app/login/page.tsx`, `app/register/page.tsx` | halaman |
| `components/profile/LogoutButton.tsx` | `signOut` |
| `components/profile/{ProfileHeader,MenuList}.tsx`, `app/profile/page.tsx`, `ProfileContent.tsx` | profil customer |
| `components/orders/OrdersPage.tsx` | `fetch("/api/orders")` |
| `components/products/ProductDetail.tsx` | `useSession()`; guest → `showLoginPrompt` + `router.push("/login?callbackUrl=...")` (baris ~65, 336, 488, 940) |
| `components/SpinWheelContainer.tsx`, `SpinWheelPopup.tsx` | `useSession()`; tidak render bila tanpa sesi |
| `components/analytics/TikTokAdvancedMatching.tsx` | `useSession()` |
| `components/products/GuestDivider.tsx` | CTA Login/Register + menyebut "wishlist" |
| `components/Footer.tsx` | link `/register` (baris 109) & `/login` (baris 118) |
| `components/products/BottomNavbar.tsx` | tab "Saya" → `/profile` |

### B.5 Halaman yang memanggil `auth()`

`app/{admin/layout,admin/products,admin/settings,admin/whatsapp,affiliate,products,products/[slug],home,campaigns,promotions,flash-sales,cart,checkout,buy-now,orders,profile,checkout/success,checkout/payment/[id]/layout,orders/[id]/layout}`.

Guard yang **sudah ada**:
- `app/checkout/page.tsx` → `redirect("/login?callbackUrl=/checkout")`
- `app/buy-now/page.tsx` → `redirect("/login?callbackUrl=/buy-now")`
- `app/profile/page.tsx` → `redirect("/login")`
- `app/orders/page.tsx` → **soft-login gate** (halaman publik, `OrdersPage` tidak dirender untuk guest)
- `app/cart/page.tsx` → merender **kosong** bila tanpa sesi (bukan redirect)
- `app/home/page.tsx` → merender **`<main>` kosong** bila tanpa sesi (baris 511)

### B.6 Fitur auth yang **TIDAK ADA** (jangan diasumsikan ada)

- **Forgot / reset password: TIDAK ADA.** `model VerificationToken` ada di schema tetapi **tidak pernah digunakan** (0 referensi di `app/` dan `lib/`). `LoginForm.tsx` hanya menyebut kata "forgot", tanpa route/flow.
- **Wishlist: TIDAK ADA.** Tidak ada `model Wishlist`. Hanya disebut sebagai teks di `GuestDivider.tsx` dan didaftarkan di `proxy.ts` (`PROTECTED_PAGE_ROUTES` + matcher `/wishlist/:path*`) → **route hantu**.
- **Review produk: TIDAK ADA.** Tidak ada `model Review` maupun UI review.

---

## C. Database Impact

### C.1 Relasi yang terikat `User` (dari `prisma/schema.prisma`)

| Model | Field | Wajib? | OnDelete | Dampak guest checkout |
|---|---|---|---|---|
| `Order` | `userId String` | **WAJIB** | **Cascade** | **BLOCKER #1** — harus `String?` + `SetNull`/`Restrict` |
| `Cart` | `userId String @unique` | **WAJIB** | Cascade | **BLOCKER #2** — guest tanpa cart server |
| `CartItem` | `cartId` | WAJIB | Cascade | Ikut `Cart` |
| `UserAddress` | `userId String` | **WAJIB** | Cascade | **BLOCKER #3** — checkout hanya menerima `addressId` milik user |
| `Notification` | `userId String?` | nullable | SetNull | Aman |
| `Account` | `userId String` | WAJIB | Cascade | OAuth/OAuth-only |
| `Session` | `userId String` | WAJIB | Cascade | Tidak terpakai (strategy JWT) |
| `AffiliateProfile` | `userId String @unique` | WAJIB | Cascade | Affiliator tetap butuh akun |
| `AffiliateClick` | `sessionId String?` | nullable | — | Aman (sudah anonymous-friendly) |
| `AffiliateConversion` | `orderId @unique`, `onDelete: Restrict` | — | Restrict | Aman; menguntungkan (order tak bisa dihapus) |
| `FlashSalePurchase` | `userId String`, `@@unique([flashSaleId, userId])` | WAJIB | default (Restrict) | Per-user purchase limit hilang tanpa identitas |
| `VoucherUserUsage` | `userId String`, `@@unique([voucherId, userId])` | WAJIB | default | Per-user voucher cap hilang |
| `SpinWheelSpin` | `userId String` | WAJIB | Cascade | Fitur ini secara desain per-akun |
| `AdminAuditLog` | `adminId String` (tanpa relasi FK) | WAJIB | — | Aman |

### C.2 Kolom yang hilang untuk guest checkout

- `Order` **tidak punya kolom email**. `buyerEmail` iPaymu hari ini diambil dari `session.user.email` (`app/api/payment/ipaymu/route.ts`, `app/api/orders/[id]/repay/route.ts`). Guest wajib mengisi email → perlu kolom `customerEmail String?`.
- `Order` tidak punya token akses guest → perlu `guestAccessToken String? @unique` (simpan **hash**, bukan plaintext).
- `Order.userId` perlu di-index ulang sebagai nullable (`@@index([userId])` sudah ada).

### C.3 Rancangan migration yang aman (kompatibel order lama)

**Prinsip: additive-first, destructive-never.**

- **JANGAN** `DROP TABLE user`. Ini akan (a) memutus login admin, (b) memutus seluruh aksi admin (`requireAdmin` → `session.user.id`), (c) memutus affiliate, (d) menghapus riwayat order.
- **JANGAN** menghapus baris `User` milik pelanggan lama — riwayat order dan `AffiliateConversion (Restrict)` bergantung padanya.

Urutan yang direkomendasikan:

```sql
-- Migrasi 1 (additive, aman, tanpa downtime logis)
ALTER TABLE `order`
  MODIFY userId VARCHAR(191) NULL,
  ADD COLUMN customerEmail VARCHAR(191) NULL,
  ADD COLUMN guestAccessToken VARCHAR(191) NULL,
  ADD UNIQUE KEY `order_guestAccessToken_key` (guestAccessToken);

-- FK Order -> User: Cascade  →  SetNull (JANGAN onDelete lain)
-- (di Prisma: user User? @relation(fields:[userId], references:[id], onDelete: SetNull))
```

- `onDelete: SetNull` (bukan `Restrict`) dipilih agar operasi admin/GDPR yang menghapus satu akun pelanggan tidak memblokir atau menghapus ordernya — order tetap ada dengan `userId = NULL`.
- `Cart`: opsi (a) `userId` menjadi nullable + kolom `anonymousId`, atau (b) biarkan `Cart` untuk user login dan tambahkan cart anonim terpisah. **Cart guest tidak boleh memakai `Cart` dengan `userId` non-null.**
- `UserAddress`: biarkan apa adanya untuk order lama. Guest checkout **tidak menulis** ke `UserAddress` — data alamat disimpan langsung di `Order` (yang sudah punya `recipientName/phone/address/province/city/district/postalCode/latitude/longitude`).
- Migration harus **idempotent** dan dijalankan tanpa `db push` di production.

### C.4 Data historis yang harus dipertahankan

`Order` + `OrderItem` (histori penjualan), `Refund`, `AffiliateConversion`/`AffiliatePayout` (kewajiban finansial), `Notification` (audit outbound), `AdminAuditLog`, `ShipmentJob`.

---

## D. Guest Checkout Architecture

### D.1 Alur target

```
1. Guest pilih produk (katalog sudah publik: /api/products tidak lagi bestseller-only)
2. Guest pilih kurir → ongkir dihitung SERVER-side
   (POST /api/shipping/cost + /api/mengantar/estimate — saat ini /api/mengantar/* & /api/rajaongkir/* ada di PROTECTED_API_PREFIXES)
3. Guest isi: nama, email, no. HP, alamat (inline, tanpa UserAddress)
4. Guest pilih pembayaran (COD / BANK_TRANSFER / E_WALLET / QRIS)
5. Server: createCheckoutOrder() dengan userId = null, customerEmail, guestAccessToken
6. Server balas { orderNumber } + set cookie httpOnly guest token
7. Guest buka halaman status/tracking dengan orderNumber + token (atau cookie)
```

### D.2 Perubahan inti per lapisan

| Lapisan | Saat ini | Target |
|---|---|---|
| Cart | `prisma.cart.findUnique({ where: { userId } })` | Cart anonim (cookie `cart_id`) atau checkout dari client cart (state Zustand sudah ada) |
| `createCheckoutOrder` | `input.userId: string`; `prisma.userAddress.findFirst({ id, userId })` | `input.userId: string \| null`; alamat inline tervalidasi + area di-resolve server-side |
| Ongkir | origin `StoreSetting`, destination `UserAddress.mengantarDestinationAreaId` / `rajaOngkirDestinationId` | destination di-resolve server-side dari provinsi/kota/kecamatan/kelurahan guest |
| Order | `userId` wajib | `userId: null`, `customerEmail`, `guestAccessToken` (hash) |
| Voucher | `validateAndCalculateVoucherEnhanced(..., userId, ...)` | Terima `userId \| null` (`lib/voucher.ts` sudah `userId: string \| null` untuk signature-nya — lihat §E) |
| Order lookup | `where: { id, userId }` | `where: { orderNumber, guestAccessToken }` ATAU `userId` bila login |
| Halaman bayar | `/checkout/payment/[id]` + ownership `userId` | Butuh token; `Order.id` **tidak boleh** menjadi kredensial |
| Tracking | `where: { id, userId }` | Token/orderNumber scoped |

### D.3 Kepemilikan order guest — aturan yang diwajibkan

1. **Nomor pesanan saja TIDAK cukup.** Format saat ini: `{ORD|PAY-BN|PAY-CART}-{Date.now()}-{8 hex}` (`makeOrderNumber` di `lib/checkout.ts`). Meskipun timestamp+hex tidak sepele, ia dapat ter-screenshot/ter-share, dan `Order.id` **berurutan**.
2. Wajib: **`orderNumber` + `guestAccessToken`** (hash 32 byte, entropy kriptografis, satu kali per order, dirotasi bila dicurigai bocor), atau **`orderNumber` + (email ATAU 4 digit terakhir HP)** sebagai faktor kedua dengan rate limit ketat.
3. Jangan pernah menjadikan `/orders/[id]` (auto-increment) dapat diakses guest tanpa token → ini IDOR klasik.

### D.4 Validasi & perlindungan minimum

- Validasi zod/server untuk: nama, email (format + normalisasi), no. HP (E.164/`08xx`), alamat, berat.
- Rate limit per IP + per email + per no. HP.
- Idempotency key untuk mencegah double order (lihat §F.9).
- Verifikasi email/OTP (opsional, keputusan bisnis) untuk NON-COD dan/atau nilai transaksi tinggi.

---

## E. Feature Impact Matrix

Kode: **A** = hapus sepenuhnya · **B** = ubah ke guest-based · **C** = pertahankan (internal/admin) · **D** = butuh keputusan bisnis.

| Fitur | Bukti aktual | Nasib | Catatan |
|---|---|---|---|
| Google OAuth login | `auth.ts` provider `Google` | **A** | Aman dihapus; tidak dipakai admin |
| Login/register customer | `LoginForm`, `RegisterForm`, `/login`, `/register`, `app/api/auth/register` | **B/D** | **`/login` + provider Credentials harus tetap hidup untuk admin** |
| Session/JWT/AuthProvider | `auth.ts`, `components/providers/AuthProvider.tsx` | **C** | PERTAHANKAN untuk admin |
| Profile/akun customer | `app/profile/*`, `app/api/profile` | **A** | Hapus UI; biarkan kolom |
| Logout | `components/profile/LogoutButton.tsx` | **C** | Pindahkan ke admin |
| Address book | `/addresses`, `/api/addresses`, `UserAddress` | **A** (UI) / **C** (tabel) | Guest isi alamat inline |
| Cart server | `Cart.userId @unique` | **B** | Cart anonim atau client-side |
| Buy Now | `app/api/buy-now/*` | **B** | Sudah paling dekat ke guest (hanya butuh alamat) |
| Riwayat pesanan | `/orders`, `OrdersPage` | **B** | Butuh lookup token |
| Tracking | `/api/orders/[id]/tracking` | **B** | Scoped token |
| COD | `Order_paymentMethod.COD`, shipment enqueue di `lib/checkout.ts` | **B** | Paling berisiko disalahgunakan (§F.5) |
| NON-COD iPaymu | `lib/payment/*` | **B** | Butuh email guest; settlement lewat webhook (tetap aman) |
| Voucher global quota | `Voucher.quota`/`usedCount` | **B** | Aman tanpa userId |
| Voucher `maxUsagePerUser` | `VoucherUserUsage`, `lib/voucher.ts:325-337` | **B/D** | Hilang tanpa identitas → ganti email/HP |
| Voucher `eligibility=NEW_USER/RETURNING_USER` | `lib/voucher.ts:389-409` (`order.count({ userId })`), `app/api/vouchers/available` | **D** | Perlu definisi "user baru" untuk guest |
| Flash Sale per-user limit | `FlashSalePurchase` (`@@unique([flashSaleId,userId])`), `recordFlashSalePurchase` | **B/D** | Perlu identitas atau limit global saja |
| Spin Wheel | `SpinWheelSpin.userId` wajib, `SpinWheelContainer` `useSession()` | **C/D** | Secara desain per-akun; tidak cocok untuk guest murni |
| Affiliate referral (atribusi) | `lib/affiliate/referral.ts` cookie `aff_ref` | **B** | **Sudah berbasis cookie, bukan session** → tetap jalan |
| Affiliate self-referral guard | `lib/checkout.ts`: `affiliate.userId === input.userId` | **D** | Dengan `userId = null` guard ini tidak berfungsi → komisi bisa jadi self-referral |
| Affiliate dashboard/payout | `app/api/affiliate/*`, `app/affiliate/*` | **C** | Affiliator tetap perlu akun |
| TikTok Pixel (browser) | `components/analytics/TikTokPixel.tsx` | **B** | Jalan untuk guest |
| TikTok Events API (server) | `lib/analytics/tiktok-events-api.ts` → `externalId: order.userId` | **B** | Ganti ke hash email/HP atau orderNumber |
| TikTok Advanced Matching | `components/analytics/TikTokAdvancedMatching.tsx`, `app/api/analytics/tiktok-match/route.ts` (`where: { id: userId }`) | **B** | Sumber data = tabel `User`; guest perlu kirim email dari form checkout |
| Purchase dedup | `buildTikTokEventId(event, order.orderNumber)` | **C** | Sudah berbasis orderNumber, aman |
| Notifikasi customer | `Notification.userId` nullable, `lib/notification/order-status-handler.ts` | **B** | Kirim ke `Order.phone` (sudah dipakai) |
| Broadcast | `lib/marketing/broadcast.ts` → `distinct: ["userId"]`, `o.user.phone/email` | **C/D** | Audiens berbasis user login; guest tidak akan masuk audiens |
| Review produk | — | **Tidak ada** | Tidak ada yang perlu dihapus |
| Wishlist | — | **Tidak ada** (hanya teks + matcher hantu) | Bersihkan referensi hantu |
| Admin order management | `app/admin/orders/*`, `app/api/admin/orders/*` | **C** | Harus tahan `userId = null` di query/join |
| Anti-fraud | `lib/rate-limit.ts` | **B** | Lihat §F |

---

## F. Security Risks

### CRITICAL

**F.1 — `Order.userId` `onDelete: Cascade` × rencana "hapus login customer".**
Menghapus satu baris `User` menghapus semua `Order` + `OrderItem` + `Notification` + `SpinWheelSpin` + `ShipmentJob` milik user itu (MySQL `ON DELETE CASCADE`). Ini kehilangan data finansial permanen.
*Mitigasi:* ubah ke `SetNull` di migration yang sama, dan larang keras operasi `prisma.user.delete()` pada customer.

**F.2 — IDOR / enumerasi order guest.**
`Order.id` adalah `Int @default(autoincrement())` dan dipakai di URL (`/orders/[id]`, `/checkout/payment/[id]`) serta API. Lookup saat ini dilindungi hanya oleh `where: { id, userId }`. Untuk guest, scope ini hilang.
*Mitigasi:* wajib `guestAccessToken` (hash) atau faktor kedua (email/HP); jangan pernah mengizinkan akses order guest hanya dengan `id`/`orderNumber`. Rate-limit endpoint lookup.

**F.3 — Kebocoran instruksi pembayaran.**
`GET /api/orders/[id]/payment-status` (`loadPaymentView`) mengembalikan `paymentNo` (nomor VA) / `qrString` / `paymentUrl`. Jika scope guest salah, penyerang bisa **membelokkan pembayaran** ke VA yang bocor.
*Mitigasi:* token scoping wajib; tetap sertakan `Cache-Control: no-store` (sudah ada).

### HIGH

**F.4 — Rate limiting tidak efektif untuk guest.**
`lib/rate-limit.ts`: semua limiter order/payment/voucher di-key `userId` (`orderCreation(userId)`, `paymentCreation(userId)`, `repayment(userId)`, `refundRequest(userId)`). Tanpa `userId`, key menjadi `undefined`. Selain itu `getClientIp()` mengembalikan literal `"untrusted"` bila `TRUSTED_PROXY` tidak di-set → **seluruh internet berbagi satu bucket** (DoS ke semua guest sekaligus) atau kehilangan proteksi per-klien.
*Mitigasi:* set `TRUSTED_PROXY` di production, tambahkan limiter ber-key kombinasi IP + hash(email/HP) + cookie perangkat; limiter in-memory hanya valid 1 instance (sudah ada peringatan `REDIS_URL`).

**F.5 — Penyalahgunaan COD & spam order.**
COD tidak butuh pembayaran di muka, dan `createCheckoutOrder` langsung meng-enqueue `ShipmentJob` untuk Mengantar COD. Guest anonim dapat membuat order COD fiktif massal.
*Mitigasi:* rate limit per IP/HP/email, verifikasi OTP (keputusan bisnis), opsional auto-hold/approval admin untuk COD bernilai tinggi, blokir alamat/HP yang berulang gagal, pantau `ShipmentJob` gagal.

**F.6 — Kebocoran per-user limit voucher & flash sale.**
`VoucherUserUsage` (`@@unique([voucherId,userId])`) dan `FlashSalePurchase` (`@@unique([flashSaleId,userId])`) hilang maknanya tanpa identitas. `eligibility = NEW_USER` memakai `order.count({ userId })`.
*Mitigasi:* identitas ringan berbasis email/HP (verified) atau batasi ke kuota global + rate limit ketat + monitoring.

**F.7 — Self-referral affiliate.**
`lib/checkout.ts` memblokir komisi bila `affiliate.userId === input.userId`. Dengan `userId = null`, afiliator bisa membuat order guest melalui link rujukannya sendiri dan memanen komisi.
*Mitigasi:* bandingkan dengan email/HP yang di-hash terhadap profil afiliator, atau tandai order guest sebagai non-komisi sampai terverifikasi.

### MEDIUM

**F.8 — Manipulasi harga / ongkir / stok.** Saat ini **sudah aman**: `createCheckoutOrder` mengabaikan `shipping.cost` dari client dan memakai `verifyMengantarShippingCost()` / `verifyRajaOngkirShippingCostOrThrow()`; harga dari `resolveBatchPrices`; stok di-update dengan `updateMany({ where: { stock: { gte } } })` (CAS). **Jangan regresi ini saat menambah jalur alamat guest** — area tujuan wajib di-resolve server-side, bukan dari `destinationId` kiriman browser.

**F.9 — Duplikasi order/pembayaran.** `cleanupPendingCheckoutOrders(userId)` berjalan per user. Guest tidak punya pembersihan ini → double-submit dapat menumpuk order PENDING/VA ganda.
*Mitigasi:* idempotency key per checkout attempt (cookie/header) + unique constraint pada `paymentReference`.

**F.10 — CSRF.** `lib/csrf.ts` mendefinisikan `requireSession()`/`requireAdminSession()` tetapi **tidak dipakai sama sekali** — proteksi CSRF yang didokumentasikan sebenarnya tidak aktif. Selama endpoint guest tetap memakai cookie (cart/token), endpoint state-changing wajib memvalidasi `Origin`/`Sec-Fetch-Site` atau memakai token anti-CSRF.

**F.11 — Spin wheel abuse.** `/api/spin-wheel/spin` di-key `session.user.id`; bila dibuat guest-based tanpa identitas, putaran bisa di-spam.

### LOW

**F.12 — Webhook replay.** Signature + CAS sudah benar (`ipaymu/notification`, `mengantar/webhook`). Pertahankan; jangan tambahkan jalur "settle by client request".
**F.13 — Cookie token guest.** Harus `httpOnly`, `Secure`, `SameSite=Lax/Strict`, scoped path, dan dirotasi.
**F.14 — Halaman "hantu".** `proxy.ts` mem-matcher `/wishlist/:path*` dan `PROTECTED_PAGE_ROUTES` memuat `/wishlist`, walau fitur tidak ada. Dead link/guard membingungkan dan menutupi kesalahan konfigurasi.
**F.15 — TikTok attribution quality.** `externalId: order.userId` → `null/undefined` untuk guest menurunkan match rate, bukan risiko keamanan.

**Prinsip yang tidak boleh dilanggar:** kehilangan login customer **tidak boleh** menurunkan proteksi admin (proxy guard `/admin` + `app/admin/layout.tsx` role check + `requireAdmin()` di ~70 API). Ketiganya harus tetap utuh.

---

## G. Implementation Plan

> Setiap phase harus hijau (`tsc`, `next build`, Jest) sebelum lanjut.

### Phase 1 — Persiapan database & guest order
- **File:** `prisma/schema.prisma`, `prisma/migrations/**`.
- **Perubahan:** `Order.userId → String?` + `onDelete: SetNull`; tambah `customerEmail String?`, `guestAccessToken String? @unique`.
- **Alasan:** membuka jalan tanpa menyentuh perilaku login.
- **Risiko:** migration pada tabel `order` besar — jadwalkan di luar jam sibuk; pastikan FK drop/recreate benar di MySQL.
- **Dependensi:** backup DB (sudah ada `toko_backup.sql` sebagai pola).
- **Test:** `__tests__/checkout/lifecycle.test.ts`, `__tests__/p0/checkout-cleanup.test.ts`, seluruh `__tests__/security/mengantar-*`.
- **Rollback:** migration `down` manual yang mengembalikan `NOT NULL` hanya bila tidak ada order guest; kalau ada, biarkan nullable.

### Phase 2 — Cart & Buy Now tanpa login
- **File:** `proxy.ts` (keluarkan `/api/cart`, `/api/buy-now`, `/cart`, `/buy-now` dari guard), `app/api/cart/route.ts`, `app/api/buy-now/route.ts`, `components/cart/*`, `app/buy-now/*`.
- **Perubahan:** cart anonim (cookie cart-id / cart client) atau fallback ke Buy Now murni.
- **Risiko:** cart user login yang sudah ada harus tetap terbaca (dual-mode).
- **Dependensi:** Phase 1.
- **Test:** `__tests__/security/guest-catalog-and-orders.test.ts`, `__tests__/p0/remediation.integration.test.ts`.
- **Rollback:** feature flag cart guest.

### Phase 3 — Guest checkout
- **File:** `lib/checkout.ts` (`CreateCheckoutInput.userId: string | null`, alamat inline, resolve area server-side), `app/api/checkout/route.ts`, `app/api/orders/route.ts`, `app/api/payment/ipaymu/route.ts`, `app/api/buy-now/ipaymu/route.ts`, `app/checkout/CheckoutPage.tsx`, `app/checkout/page.tsx`.
- **Risiko:** (a) regresi verifikasi ongkir, (b) `cartId` null handling, (c) emisi `guestAccessToken`.
- **Test:** `__tests__/security/checkout-price-baseline.test.ts`, `__tests__/marketing/checkout-price-baseline.test.ts`, `__tests__/marketing/e2e-numeric-verification.test.ts`, `__tests__/security/mengantar-shipping.test.ts`.
- **Rollback:** jalur login tetap ada; matikan hanya jalur guest.

### Phase 4 — Payment, webhook & shipment compatibility
- **File:** `lib/checkout.ts` (enqueue COD), `lib/mengantar/shipment-worker.ts`, `lib/payment/order-payment.ts`, `app/api/payment/ipaymu/notification/route.ts`, `app/api/mengantar/webhook/route.ts`, `lib/notification/order-status-handler.ts`.
- **Perubahan:** `buyerEmail` dari `Order.customerEmail` (fallback session bila login); notifikasi ke `Order.phone`.
- **Risiko:** order COD tanpa `userId` → semua lookup harus berbasis `orderId`/`orderNumber`, bukan user.
- **Test:** `__tests__/ipaymu/webhook-hardening.test.ts`, `__tests__/ipaymu/direct-payment.test.ts`, `__tests__/order-refund/refund-repay-webhook.test.ts`, `__tests__/security/mengantar-auto-shipment.test.ts`, `__tests__/security/mengantar-webhook.test.ts`, `__tests__/security/mengantar-cod-lifecycle.test.ts`.

### Phase 5 — Guest order lookup & keamanan
- **File:** `app/api/orders/[id]/route.ts`, `.../tracking`, `.../payment-status`, `app/orders/page.tsx`, `app/orders/[id]/*`, `app/checkout/payment/[id]/*`, `app/api/payment/status/route.ts`, `lib/rate-limit.ts`.
- **Perubahan:** ownership = `userId` **atau** `guestAccessToken`; limiter guest; validasi Origin.
- **Risiko:** **tertinggi** — IDOR bila scope salah.
- **Test:** tambah suite baru khusus (guest token valid/invalid/expired, enumerasi id, rate limit) + `__tests__/p0/repay-concurrency.test.ts`.
- **Rollback:** token lookup dapat dimatikan tanpa memengaruhi user login.

### Phase 6 — Penyesuaian fitur customer lain
- **File:** `lib/voucher.ts`, `app/api/voucher/validate/route.ts`, `app/api/vouchers/available/route.ts`, `lib/marketing/flash-sale.ts`, `lib/analytics/*`, `components/analytics/TikTokAdvancedMatching.tsx`, `lib/marketing/broadcast.ts`.
- **Keputusan:** strategi identitas voucher/flash-sale, spin wheel, affiliate self-referral, broadcast audience.

### Phase 7 — Penghapusan UI, route, API & dependency login customer
- **Hapus:** `components/auth/RegisterForm.tsx`, `app/register/page.tsx`, `app/api/auth/register/route.ts`, `lib/validations/register.ts`, `lib/services/auth.ts`, `app/profile/**`, `app/api/profile/route.ts`, `app/addresses/**`, `app/api/address{,es}/**`, CTA login di `GuestDivider.tsx`/`Footer.tsx`/`ProductDetail.tsx`, provider `Google` di `auth.ts`, `lib/csrf.ts` (dead code), entri hantu `/wishlist` di `proxy.ts`.
- **PERTAHANKAN:** `auth.ts` (Credentials), `/login` (**jadikan khusus admin** atau ganti ke `/admin/login`), `AuthProvider`, `SessionProvider`, `lib/admin.ts`, `app/admin/layout.tsx`, `/api/admin/**`.
- **Risiko:** **breaking login admin** — ini risiko nomor satu pada phase ini.
- **Test:** suite admin (`__tests__/security/admin-tracking-routing.test.ts`, `__tests__/admin/*`) + smoke test manual login admin.
- **Rollback:** revert commit (tidak ada migration di phase ini).

### Phase 8 — Cleanup schema & migration setelah dependensi aman
- Hapus `Account`/`Session` bila strategy JWT dipertahankan oleh admin; **jangan** hapus `User`, `UserAddress`, `VoucherUserUsage`, `FlashSalePurchase` selama masih ada data historis (lebih aman: biarkan).
- Buat FK `Order.userId → user.id (SetNull)` final.
- **Test:** `prisma validate`, `prisma generate`, `tsc --noEmit`, full Jest.

### Phase 9 — Regression test & deployment plan
- Tambah/aktifkan suite guest; jalankan `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`.
- Deploy: backup DB → migration → deploy → verifikasi webhook iPaymu & Mengantar di production → monitor order PENDING menggantung & spam.

---

## H. Regression Test Checklist

**Guest flow**
- [ ] Guest bisa lihat katalog penuh (`/products`, `/products/[slug]`) — sudah diuji `__tests__/security/guest-catalog-and-orders.test.ts`.
- [ ] Guest bisa tambah ke cart / Buy Now tanpa redirect `/login`.
- [ ] Guest checkout COD: order dibuat, `userId = NULL`, `recipientName/phone/email/address` tersimpan.
- [ ] Guest checkout NON-COD (BANK_TRANSFER / E_WALLET / QRIS): VA/Qris tampil, `expiresAt` benar.
- [ ] Guest menerima nomor pesanan dan **tidak** diarahkan ke login.

**Order lookup & keamanan**
- [ ] `orderNumber + token` valid → detail muncul.
- [ ] `orderNumber` tanpa token → 401/404.
- [ ] Enumerasi `Order.id` berurutan tanpa token → ditolak.
- [ ] Token order A tidak bisa membaca order B.
- [ ] Rate limit lookup tercapai → 429.
- [ ] `/api/orders/[id]/payment-status` tidak pernah mengembalikan data order milik orang lain.

**Payment**
- [ ] Webhook iPaymu signature valid → PAID; signature invalid → ditolak.
- [ ] Webhook replay → idempotent (tidak menggandakan settlement).
- [ ] Duplicate payment / double-submit → tidak ada dua order/instruksi ganda.
- [ ] COD tetap `UNPAID` (tidak pernah dianggap PAID).
- [ ] Repay (`/api/orders/[id]/repay`) untuk guest memakai token, bukan session.
- [ ] Refund tetap berjalan untuk order lama (dengan `userId`) dan order guest.
- [ ] Order expired → `rollbackCheckoutOrder` mengembalikan stok/voucher/spin.

**Shipping**
- [ ] Auto-shipment Mengantar untuk COD tetap ter-enqueue (`ShipmentJob` unik per order).
- [ ] Auto-shipment NON-COD ter-trigger dari settlement webhook.
- [ ] COD & NON-COD courier kompatibel (`__tests__/security/mengantar-cod-courier.test.ts`).
- [ ] Pickup schedule resolve & tidak di-reuse (`lib/mengantar/pickup-schedule.ts`).
- [ ] `shippingPaymentStatus` (seller→Mengantar) tetap terpisah dari `paymentStatus` (customer→marketplace).
- [ ] Tracking guest aman + `trackingUrl` benar.
- [ ] Webhook shipment-status → notifikasi + status order.
- [ ] Reconcile & retry (`__tests__/security/mengantar-reconcile.test.ts`).

**Voucher & harga**
- [ ] Voucher valid/invalid, kuota habis, `minPurchase`, restriksi produk/kategori.
- [ ] Diskon ongkir dan voucher tidak dobel (`F9` precedence).
- [ ] Harga & stok tetap server-authoritative (client memalsukan `cost` → diabaikan).
- [ ] Compare price tidak pernah ditagih.

**Admin (harus tetap hijau)**
- [ ] `/admin` tanpa sesi → redirect `/login`.
- [ ] `/admin` dengan role CUSTOMER → redirect `/products`.
- [ ] `/api/admin/*` tanpa sesi → 401; role non-admin → 403.
- [ ] Admin order list memuat order dengan `userId = NULL` tanpa error.
- [ ] Scan resi, tracking import, refund admin, broadcast tetap jalan.

**Build & tipe**
- [ ] `npx tsc --noEmit` bersih.
- [ ] `npm run lint` bersih.
- [ ] `npm test` (suite di `jest.config.js`) hijau.
- [ ] `npm run build` sukses.

---

## I. File-by-File Change List

### I.1 Auth core
| Path | Fungsi | Aksi |
|---|---|---|
| `auth.ts` | `NextAuth()`, provider `Google`/`Credentials`, callbacks, `pages.signIn` | Hapus provider `Google`; **pertahankan** `Credentials`, `PrismaAdapter`, callbacks, `pages.signIn` |
| `app/api/auth/[...nextauth]/route.ts` | `handlers` | Pertahankan |
| `app/api/auth/register/route.ts` | Registrasi customer | Hapus (keputusan §J-1) |
| `lib/password.ts`, `lib/admin.ts`, `lib/admin-bootstrap.ts`, `scripts/admin-create.ts` | Admin/kredensial | Pertahankan |
| `lib/auth.ts` | `AUTH_ROUTES` | Sesuaikan (buang `REGISTER`) |
| `lib/services/auth.ts`, `lib/validations/register.ts` | Registrasi client | Hapus |
| `lib/csrf.ts` | `requireSession`, `requireAdminSession` (tidak dipakai) | Hapus atau implementasikan (lihat §F.10) |
| `proxy.ts` | Guard API & page | Hapus route customer dari `PROTECTED_*`; **pertahankan** `/admin`, `/api/admin/`, webhook; buang `/wishlist` hantu |

### I.2 Checkout & order
| Path | Fungsi | Aksi |
|---|---|---|
| `lib/checkout.ts` | `createCheckoutOrder`, `verifyShippingCost`, `rollbackCheckoutOrder`, `cancelOwnPendingOrder`, `clearCart`, `makeOrderNumber` | `userId: string \| null`, alamat inline, resolve area server-side, `customerEmail`, `guestAccessToken`; **jangan ubah** verifikasi ongkir/harga |
| `app/api/checkout/route.ts` | `GET` data checkout | Keluarkan `auth()`; alamat dari payload |
| `app/api/orders/route.ts` | `POST` COD, `GET` riwayat | `POST` → guest; `GET` → guest token |
| `app/api/orders/[id]/route.ts` | Detail order | Ownership: `userId` ATAU token |
| `app/api/orders/[id]/tracking/route.ts` | Tracking | Idem |
| `app/api/orders/[id]/{cancel,expire,payment-status,refund,repay}/route.ts` | Lifecycle order | Idem + rate limit guest |
| `app/api/payment/ipaymu/route.ts` | `POST` non-COD | `session.user.id` → guest ID; `buyerEmail` dari `customerEmail` |
| `app/api/payment/status/route.ts` | Status pembayaran | Guest token; `externalId` TikTok dari hash email |
| `app/api/buy-now/route.ts`, `app/api/buy-now/ipaymu/route.ts`, `app/api/buy-now/shipping/route.ts` | Buy Now | Guest |
| `app/api/cart/route.ts`, `app/api/cart/[itemId]/route.ts` | Cart CRUD | Guest cart |
| `lib/repay.ts`, `lib/payment/order-payment.ts` | `processRepayment`, `loadPaymentView`, `expireUnpaidOrderIfExpired` | Terima scope token |
| `lib/rate-limit.ts` | `rateLimiters.*` | Tambah limiter guest (IP/email/HP); `getClientIp` + `TRUSTED_PROXY` |

### I.3 Alamat
| Path | Aksi |
|---|---|
| `app/api/addresses/route.ts`, `app/api/addresses/[id]/route.ts`, `app/api/address/route.ts` | Hapus/ubah ke validasi alamat inline (resolve area server-side wajib) |
| `app/addresses/**`, `app/api/admin/settings/regions/**` | Hapus UI customer; admin region sync tetap |

### I.4 UI
| Path | Aksi |
|---|---|
| `components/auth/RegisterForm.tsx`, `app/register/page.tsx` | Hapus |
| `components/auth/LoginForm.tsx`, `app/login/page.tsx` | Jadi khusus admin |
| `components/profile/**`, `app/profile/**` | Hapus |
| `components/products/GuestDivider.tsx` | Hapus/replace (CTA login + teks "wishlist") |
| `components/Footer.tsx:109,118` | Hapus link register/login |
| `components/products/ProductDetail.tsx:65,336,488,940` | Ganti prompt login → lanjut guest |
| `app/checkout/page.tsx`, `app/buy-now/page.tsx` | Hapus `redirect("/login?callbackUrl=...")` |
| `app/cart/page.tsx`, `app/orders/page.tsx`, `app/home/page.tsx` | Hapus gate `session?.user` |
| `components/products/BottomNavbar.tsx` | Tab "Saya" → hapus/ganti |
| `components/SpinWheelContainer.tsx`, `SpinWheelPopup.tsx`, `components/analytics/TikTokAdvancedMatching.tsx` | Sesuaikan per keputusan §J |

### I.5 Schema
| Path | Aksi |
|---|---|
| `prisma/schema.prisma` — `Order` | `userId String?`, relasi `onDelete: SetNull`, `+customerEmail`, `+guestAccessToken @unique` |
| `prisma/schema.prisma` — `Cart` | `userId` nullable + identitas anonim (atau tabel cart guest) |
| `User`, `UserAddress`, `VoucherUserUsage`, `FlashSalePurchase`, `SpinWheelSpin`, `AffiliateProfile`, `Account`, `Session` | **JANGAN hapus selama ada data historis / admin / affiliate** |

---

## J. Open Decisions

1. **Registrasi customer dihapus total atau dibiarkan sebagai opsi?**
   Register membuat `User` yang juga menampung `referralCode`/`referredBy`. Menghapusnya menghilangkan jalur referral organik.

2. **Login customer: dihapus total atau "opsional"?**
   Opsi A: hapus `/login` untuk customer, sisakan jalur admin (mis. `/admin/login` terpisah — butuh perubahan `auth.ts` `pages.signIn` + `proxy.ts`).
   Opsi B: pertahankan `/login` tetapi tidak pernah diwajibkan (paling murah, risiko terendah).

3. **Spin Wheel: dipertahankan (perlu akun ringan), diubah ke identitas email/HP, atau dinonaktifkan untuk guest?** `SpinWheelSpin.userId` wajib.

4. **Voucher `maxUsagePerUser` & `eligibility = NEW_USER/RETURNING_USER`: ganti ke email/HP, atau hapus per-user cap dan andalkan kuota global + rate limit?**

5. **Flash sale per-user purchase limit (`FlashSalePurchase`):** perlu keputusan — identitas ringan vs limit global.

6. **COD: apakah butuh verifikasi OTP WhatsApp/email sebelum order dibuat?** Ini mengubah UX dan menambah dependency (`lib/whatsapp/*` sudah ada).

7. **Email guest: wajibkan untuk semua checkout (dibutuhkan iPaymu) atau hanya NON-COD?** COD dapat memakai `recipientName/phone` saja.

8. **Metode akses order guest: token URL, cookie httpOnly, atau kombinasi `orderNumber + 4 digit terakhir HP`?** Menentukan bentuk API lookup.

9. **`User`/`UserAddress` untuk data historis: dipertahankan permanen atau diarsipkan?** Rekomendasi: **dipertahankan** (jangan drop).

10. **Affiliate: apakah affiliator tetap login?** Jika ya, seluruh `AuthProvider`/`session` tetap harus ada — memperkuat rekomendasi Opsi B pada #2.

11. **Broadcast audience:** apakah audiens berbasis akun tetap dipertahankan (hanya menjangkau pelanggan lama) atau diperluas ke pembeli guest via email/HP?

12. **`lib/marketing/broadcast.ts` `distinct: ["userId"]`** akan mengabaikan order guest (`userId = NULL`) — perlu keputusan apakah pembeli guest boleh masuk audiens.

---

**STOP.** Audit selesai. Semua temuan berbasis source code aktual. Belum ada implementasi, migration, atau perubahan apa pun. Menunggu persetujuan eksplisit sebelum mulai Phase 1.
