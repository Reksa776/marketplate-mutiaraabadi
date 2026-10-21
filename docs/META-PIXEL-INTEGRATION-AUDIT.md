# META PIXEL INTEGRATION — AUDIT REPORT

**Status akhir: CONDITIONAL GO**

| Item | Nilai |
|---|---|
| Tanggal audit | 21 Oktober 2026 |
| Baseline commit | `099f9af` (2026-10-19) |
| Stack | Next.js 16.3 (App Router), React 19, Prisma 6 + MySQL, NextAuth v5 |
| Metode | Pembacaan statis kode aktual (tanpa menjalankan migration, tanpa mengubah env, tanpa test event, tanpa deploy) |
| Perubahan source code | **Tidak ada** — hanya file laporan ini yang dibuat |
| Catatan working tree | Ada perubahan belum commit yang **sudah ada sebelum audit** (`app/api/payment/*/notification/route.ts`, `lib/admin/audit-log.ts`, `lib/payment/webhook-trace.ts`, `docs/order-cleanup/`, `scripts/order-cleanup/`, satu test baru). Tidak disentuh dan tidak menjadi bagian audit ini. |

> Semua temuan di bawah berasal dari kode aktual di repository. Referensi ditulis sebagai `file:baris`.

---

**Skala klasifikasi temuan:** `CRITICAL` (menghalangi go-live / kebocoran data), `HIGH` (wajib diperbaiki sebelum aktivasi), `MEDIUM` (perlu mitigasi/kesadaran), `LOW` (perbaikan opsional).
**Pada audit ini tidak ada temuan yang memenuhi kriteria `CRITICAL`.**

## 1. Executive Summary

1. **TikTok Pixel sudah matang dan terintegrasi penuh.** Konfigurasi disimpan di tabel singleton `StoreSetting` (`prisma/schema.prisma:605-659`), dibaca hanya di server (`lib/analytics/tiktok-config.ts:27`), lalu dirender sebagai `next/script` di storefront (`components/analytics/TikTokPixel.tsx`). Admin mengelola Pixel ID, nama, base code, dan Access Token di `/admin/settings` (`app/admin/settings/AdminSettingsForm.tsx`), melalui API ADMIN-only `app/api/admin/settings/route.ts` (GET `:271`, PUT `:326`).
2. **Tracking berjalan di dua channel**: browser Pixel (PageView, ViewContent, AddToCart, InitiateCheckout, AddPaymentInfo, CompletePayment) dan TikTok Events API server-side (CompletePayment saja), dengan deduplication berbasis `event_id` deterministik `ttq:completepayment:<orderNumber>` (`lib/analytics/tiktok.ts:256`, `lib/analytics/tiktok-events-api.ts:624`).
3. **Purchase tracking sudah "authoritative"**: hanya dikirim setelah status `PAID` (atau COD yang masih live), nilai dari `Order.total` di database, dan webhook memakai CAS (`settled`) sehingga replay webhook tidak menggandakan event server (`app/api/payment/midtrans/notification/route.ts:407-512`, `app/api/payment/ipaymu/notification/route.ts:473-581`).
4. **Meta Pixel belum ada sama sekali.** Tidak ada kolom database, field admin, komponen, event, maupun origin CSP untuk Meta/Facebook (satu-satunya kemunculan "facebook" adalah tombol share affiliate). Implementasi Meta harus **dibangun dari nol**, mengikuti pola TikTok tetapi **tanpa** menyimpan JavaScript mentah dari admin.
5. **Tiga blocker/conditional yang wajib diputuskan sebelum implementasi:**
   - **CSP saat ini akan memblokir Meta Pixel** (`connect.facebook.net`, `www.facebook.com` tidak ada di `script-src`/`connect-src`/`img-src` — `next.config.ts:34-47,100-110`). Perlu perubahan CSP.
   - **Tidak ada cookie-consent / tracking-consent mechanism sama sekali** di aplikasi (hasil pencarian `consent` hanya menemukan nama method TikTok di file test). Requirement "tracking hanya berjalan bila memenuhi consent" belum bisa dipenuhi tanpa keputusan produk.
   - **Database migration diperlukan** (dua kolom additive) untuk menyimpan konfigurasi Meta.
6. **Risiko duplikasi yang sudah ada (bukan baru):** halaman `payment-finish` terus polling setelah status final dan setiap respons membuat objek `order` baru, sehingga effect Purchase TikTok berjalan ulang tiap ±3 detik (`app/checkout/payment-finish/payment-finish-content.tsx:111-134` dan `:175-200`). Saat ini tertahan oleh dedup `event_id` di TikTok. Meta **wajib** memakai `eventID` + guard tambahan agar tidak mewarisi pola ini.
7. **Status: CONDITIONAL GO.** Implementasi layak dan berisiko rendah dari sisi business logic (tidak menyentuh checkout/payment gateway), dengan 5 kondisi yang harus disetujui lebih dulu (lihat §14).

---

## 2. Existing TikTok Pixel Architecture

### 2.1 Lokasi konfigurasi & penyimpanan Pixel ID

| Aspek | Temuan | Referensi |
|---|---|---|
| Tempat penyimpanan | Kolom di tabel singleton `StoreSetting` (`id = 1`) | `prisma/schema.prisma:605-659` |
| Kolom | `tiktokPixelEnabled`, `tiktokPixelId`, `tiktokPixelName`, `tiktokPixelCode`, `tiktokPixelAccessToken` | `prisma/schema.prisma:620-627` |
| Sumber Pixel ID | **Database**, bukan environment variable | `lib/analytics/tiktok-config.ts:30-38` |
| Sumber Access Token | **Database**, `@db.Text`, server-only | `prisma/schema.prisma:627`, `lib/analytics/tiktok-events-config.ts:1` (`import "server-only"`) |
| Environment variable tracking | Hanya `TIKTOK_TEST_EVENT_CODE` (opsional, test mode) | `.env.example` bagian TESTING; `lib/analytics/tiktok-test-event-code.ts` |
| Normalisasi ID | Uppercase + trim + regex `^[A-Z0-9]{10,30}$` | `lib/analytics/tiktok.ts:43,276-305` |

Catatan penting: **Pixel ID tidak dipakai untuk membangun script**. Script yang dieksekusi berasal dari `tiktokPixelCode` milik admin; `pixelId` hanya metadata (`data-pixel-id`) dan untuk mendeteksi mismatch (`lib/analytics/tiktok-config.ts:84-92`).

### 2.2 Alur server → browser

1. `app/layout.tsx:113` me-mount `<AnalyticsProvider />` di root layout.
2. `AnalyticsProvider` adalah **Server Component**; ia memanggil `getTikTokPixelConfig()` (`components/analytics/AnalyticsProvider.tsx:8,31`).
3. `getTikTokPixelConfig()` membaca DB dengan `select` eksplisit (`lib/analytics/tiktok-config.ts:30-38`), mengembalikan `DISABLED_TIKTOK_PIXEL` bila:
   - `tiktokPixelEnabled !== true`,
   - kode kosong / tidak ada JavaScript inline,
   - pembacaan DB gagal (mis. kolom belum dimigrasi) — fail-closed (`:96-104`).
4. `stripAutomaticTikTokPageView()` membuang `ttq.page()` dari **script yang dieksekusi** (kode tersimpan tidak diubah), agar PageView dikendalikan aplikasi setelah Advanced Matching siap (`lib/analytics/tiktok-pixel-code.ts:179`, `lib/analytics/tiktok-config.ts:58-67`).
5. `TikTokPixel` (Client Component) merender `next/script` dengan `strategy="afterInteractive"`, `id="tiktok-pixel-base"`, dan tidak merender apa pun di route `/admin` (`components/analytics/TikTokPixel.tsx:31-70`, `lib/analytics/tiktok.ts:311`).

**Tidak ada endpoint publik yang mengembalikan Pixel ID/Code.** Browser tidak pernah memanggil `/api/admin/settings` untuk pixel.

### 2.3 Pemasangan script

- `next/script` + inline JavaScript, satu instance di root layout (`app/layout.tsx:113`).
- Tag `<script>` dari TikTok Events Manager boleh ditempel admin; `analyzeTikTokPixelCode()` mengekstrak isi inline (`lib/analytics/tiktok-pixel-code.ts:85`).
- Kode eksternal `<script src="...">` saja ditolak saat simpan (`app/api/admin/settings/route.ts` pesan "tidak berisi JavaScript inline").
- CSP mengizinkan `https://analytics.tiktok.com` di `script-src` **dan** `connect-src`, serta `'unsafe-inline'` (`next.config.ts:34-47,100-110`). Tidak ada wildcard.

### 2.4 Tracking event (browser)

| Event | Lokasi | Gating |
|---|---|---|
| PageView | `components/analytics/TikTokPageViewTracker.tsx:106` | `whenTikTokReadyForEvents`, sekali per `pathname+search`, bukan `/admin` |
| ViewContent | `components/products/ProductDetail.tsx:139-183` | `useRef` guard per product, menunggu pixel+identity |
| AddToCart | `components/products/ProductDetail.tsx:405-425` | setelah cart API sukses |
| InitiateCheckout | `app/checkout/CheckoutPage.tsx:505-525`; `app/buy-now/BuyNowPage.tsx:1590-1615` | setelah data checkout tersedia |
| AddPaymentInfo | `app/checkout/CheckoutPage.tsx:1892-1915`; `app/buy-now/BuyNowPage.tsx:2774-2800` | saat submit order |
| CompletePayment (browser) | `components/analytics/PurchaseTracker.tsx:90`; `app/checkout/payment/[id]/page.tsx:187-215`; `app/checkout/payment-finish/payment-finish-content.tsx:175-200` | hanya `PAID` (COD: order live) |

`trackTikTokEvent()` no-op bila `window.ttq` tidak ada (`lib/analytics/tiktok.ts:394-430`), sehingga event tidak pernah "menyalakan" pixel sendiri.

### 2.5 Tracking server-side

- Satu-satunya event server: `CompletePayment` (`lib/analytics/tiktok-events-api.ts:605`).
- Dipanggil **hanya** dari webhook setelah transisi PAID benar-benar terjadi: `app/api/payment/midtrans/notification/route.ts:499-545`, `app/api/payment/ipaymu/notification/route.ts:568-620`.
- Identitas: raw email/phone di-hash SHA-256 di server; token akses tidak pernah ke browser (`lib/analytics/tiktok-user-match.ts`, `lib/analytics/tiktok-events-config.ts`).
- Kegagalan TikTok tidak mempengaruhi settlement (`trackTikTokServerCompletePayment` tidak melempar).

### 2.6 Browser + server, dan deduplication

- **Keduanya**: browser untuk semua event, server hanya untuk CompletePayment.
- `event_id` = `buildTikTokEventId("CompletePayment", orderNumber)` → `ttq:completepayment:<orderNumber>` (`lib/analytics/tiktok.ts:256-273`).
- Browser mengirim sebagai argumen ketiga `ttq.track(..., { event_id })` (`lib/analytics/tiktok.ts:404-425`); server mengirim field `event_id` yang sama (`lib/analytics/tiktok-events-api.ts:623-627`).
- Nilai deterministik, bukan random, sehingga kedua channel selalu menghasilkan ID identik.

---

## 3. Existing Admin Settings Architecture

### 3.1 Halaman & otorisasi

| Layer | Mekanisme | Referensi |
|---|---|---|
| Page | `auth()` + role `ADMIN`, selain itu redirect | `app/admin/settings/page.tsx:14-30` |
| API GET | `isAdmin()` → 401 | `app/api/admin/settings/route.ts:271-283` |
| API PUT | `getAdminUserId()` → 401 | `app/api/admin/settings/route.ts:326-345` |
| Proxy (defense-in-depth) | `/admin/**` dan `/api/admin/**` dijaga | `proxy.ts:18-25,60-70` |
| Audit log | `TIKTOK_PIXEL_UPDATED` hanya bila ada perubahan; kode mentah tidak pernah dicatat | `app/api/admin/settings/route.ts:958-1030`, `lib/admin/audit-log.ts:67` |

### 3.2 Field & state form

- Tipe `StoreForm` (`app/admin/settings/AdminSettingsForm.tsx:32-95`) memuat field TikTok.
- `initialForm` (`:161-200`), state `form` (`:248`), `updateField` (`:280`).
- `loadSettings()` memetakan respons API ke state (`:531-615`).
- Validasi client (`:1561-1670`) mencerminkan validasi server, tetapi server tetap sumber kebenaran.
- Payload PUT mengirim **seluruh** `form` (`:1750-1800`).
- Section UI TikTok: `:2009-2320` (toggle aktif, Pixel ID, nama, Access Token + clear, textarea Pixel Code, warning mismatch).

### 3.3 API penyimpanan

| Bagian | Detail | Referensi |
|---|---|---|
| `SETTINGS_SELECT` | Daftar field eksplisit; **Access Token tidak termasuk** | `app/api/admin/settings/route.ts:44-83` |
| GET | `...SETTINGS_SELECT` + token hanya untuk menghitung `configured`/`last4` | `:271-324`, proyeksi aman `:112-170` |
| PUT validasi TikTok | ID regex, panjang code, kode inline wajib, enable tanpa code ditolak | `:419-580` |
| PUT upsert | `create` dan `update` menulis **semua** kolom TikTok | `:750-845` (create), `:846-940` (update) |
| Revalidasi | `revalidatePath("/", "layout")` agar perubahan langsung berlaku | `:1037` |
| Warning | `pixelIdMismatch`, `hasLoadCall`, `hasPageCall`, `hasIdentifyCall` | `:1056-1070` |

### 3.4 Dampak untuk penambahan Meta

Meta dapat ditambahkan **tanpa menyentuh field TikTok**, tetapi harus konsisten di **lima titik** berikut, jika tidak konfigurasi Meta akan hilang/tertimpa:

1. `prisma/schema.prisma` (kolom baru).
2. `SETTINGS_SELECT` + `SettingsProjectionSource` + `toSettingsResponse` (`app/api/admin/settings/route.ts:44-170`).
3. Blok normalisasi/validasi PUT + `create` **dan** `update` upsert.
4. `StoreForm`, `initialForm`, `loadSettings`, validasi client, dan section UI baru di `AdminSettingsForm.tsx`.
5. `AuditAction` union (`lib/admin/audit-log.ts:15-80`) untuk aksi `META_PIXEL_UPDATED`.

**Risiko yang harus dihindari:** `PUT` saat ini menulis `tiktokPixelEnabled = body.tiktokPixelEnabled === true`. Bila field Meta ditambahkan ke DB tetapi **tidak** ditangani di PUT, setiap penyimpanan pengaturan akan mengabaikan (atau menimpa) nilai Meta. Bila field Meta ditangani dengan pola `=== true` yang sama, klien lama yang tidak mengirim field akan **menonaktifkan** Meta — konsisten dengan perilaku TikTok saat ini, tetapi perlu disadari.

**Target konsep "Pengaturan → Integrasi Tracking":** struktur halaman saat ini adalah satu halaman dengan section terpisah (bukan tab). Penambahan paling rendah risiko: section baru **"Meta Pixel"** tepat setelah section TikTok, dengan dua field saja (`Meta Pixel ID`, toggle aktif). Tidak perlu mengubah section TikTok.

---

## 4. Existing Database Structure

- Database: **MySQL** (migration memakai backtick, `prisma/migrations/*/migration.sql`).
- `StoreSetting` singleton `id = 1` (`prisma/schema.prisma:605-659`).
- Kolom tracking yang ada: `prisma/schema.prisma:619-627`.
- Tidak ada tabel event analytics, tidak ada outbox event tracking, tidak ada kolom Meta.
- Tabel pendukung Purchase: `Order` (`:231-...`), `OrderItem` (`:445-463`), enum `Order_paymentStatus` (`:808-815`).
- `Order` menyimpan `total`, `status`, `paymentStatus`, `paidAt`, `orderNumber` unik, plus attribution TikTok (`ttclid`, `ttp`, `landingUrl`, `referrer`, `clientIp`, `clientUserAgent`, `:287-310`).
- `OrderItem` menyimpan `productId`, `variantId`, `productName`, `variantName`, `price`, `quantity`, `subtotal`. **Tidak ada kolom SKU** di seluruh schema — karena itu `content_id` TikTok memakai `productId` (`lib/analytics/tiktok-catalog.ts:23-53`).
- Tidak ada tabel/kolom untuk consent.

**Konsekuensi:** Meta tidak memerlukan tabel baru; cukup dua kolom additive di `StoreSetting`.

---

## 5. Existing Tracking Events

### 5.1 Peta event aktual

| Kebutuhan | TikTok (existing) | Meta (target) | Status data |
|---|---|---|---|
| Page View | `PageView` — `TikTokPageViewTracker.tsx:106` | `PageView` | Tidak ada properti; aman |
| Product Detail | `ViewContent` — `ProductDetail.tsx:158` | `ViewContent` | `content_id`, `content_name`, `price`, `value`, `currency` |
| Add to Cart | `AddToCart` — `ProductDetail.tsx:410` | `AddToCart` | + `quantity`, `value = price × qty` |
| Begin Checkout | `InitiateCheckout` — `CheckoutPage.tsx:508`, `BuyNowPage.tsx:1597` | `InitiateCheckout` | `contents[]`, `value` dari subtotal server, `num_items` |
| Purchase | `CompletePayment` — `PurchaseTracker.tsx:90`, payment page, payment-finish, webhook | `Purchase` | `value`, `currency`, `order_id`, `contents[]` |
| (tambahan existing) | `AddPaymentInfo` — `CheckoutPage.tsx:1898`, `BuyNowPage.tsx:2780` | `AddPaymentInfo` (opsional, disarankan) | `value`, `payment_method`, `contents[]` |

### 5.2 Event yang **tidak** ada (jangan dibuat palsu)

Tidak ada `Search`, `ViewCart`, `AddToWishlist`, `Lead`, `CompleteRegistration`, `Subscribe`, `Contact`, atau `Refund` di aplikasi. Tidak ada halaman keranjang terpisah yang mengirim event. Jangan menambahkannya hanya untuk melengkapi tabel.

### 5.3 Kualitas data transaksi

| Field | Sumber aktual | Catatan |
|---|---|---|
| Product ID | `OrderItem.productId` / `CartItem.productId` (fallback `variantId`) | `lib/analytics/tiktok-catalog.ts:101-137` |
| Product name | `productName` (fallback `variantName`) | `lib/analytics/tiktok-catalog.ts:210-220` |
| Currency | Konstanta `"IDR"` | `lib/analytics/tiktok-catalog.ts:57`; toko hanya satu mata uang |
| Quantity | `OrderItem.quantity` / cart quantity, integer > 0 | `lib/analytics/tiktok-catalog.ts:159-186` |
| Transaction value | `Order.total` (authoritative DB), untuk cart: subtotal server | `PurchaseTracker.tsx` props, `CheckoutPage.tsx:520` |
| Order ID | `order.orderNumber` | `PurchaseTracker.tsx:91-105`; `payment/[id]:208-213` |

Tidak ada angka hardcoded, tidak ada nilai 0 pengganti, dan field yang tidak tersedia diomit (bukan diisi default) — pola ini harus dipertahankan untuk Meta.

---

## 6. Checkout & Purchase Tracking Analysis

### 6.1 Kapan pembayaran benar-benar berhasil

- Webhook iPaymu/Midtrans melakukan **CAS** ke `PAID` di dalam transaksi DB; `settled = true` hanya bila update benar-benar mengubah baris.
  - Midtrans: `app/api/payment/midtrans/notification/route.ts:380-407`.
  - iPaymu: `app/api/payment/ipaymu/notification/route.ts:440-473`.
- Replay webhook untuk order yang sudah PAID/EXPIRED/REFUNDED tidak melakukan apa pun (`affectedRows === 0` → return).
- COD tidak punya webhook pembayaran: order COD dianggap conversion saat order dibuat, dan **tidak** boleh fire bila `REFUNDED` atau `CANCELLED` (`app/checkout/success/page.tsx:158-176`).

### 6.2 Di mana Purchase dipicu

| Lokasi | Trigger | Gating |
|---|---|---|
| `app/checkout/success/page.tsx:202-215` | render `PurchaseTracker` | `paymentStatus === "PAID"` **atau** COD yang tidak REFUNDED/CANCELLED (`:170-176`) |
| `app/checkout/payment/[id]/page.tsx:187-215` | poll `payment-status` | `paymentStatus === "PAID"` + `completedTracked` ref |
| `app/checkout/payment-finish/payment-finish-content.tsx:175-200` | poll `payment-status` | `isPaid` |
| Webhook (server) | transisi atomik ke PAID | `settled === true` |

### 6.3 Apakah refresh menyebabkan duplicate Purchase?

- **Ya, pada level emission browser** — komponen/effect berjalan lagi setelah reload dan mengirim event yang sama. Tidak ada guard `sessionStorage`/`localStorage`.
- **Mitigasi saat ini hanya `event_id`**: browser dan server memakai ID identik, sehingga TikTok menggabungkan keduanya; pemanggilan browser berulang dengan `event_id` sama juga digabung dalam window dedup TikTok.
- **Bug tambahan (HIGH):** `payment-finish` tidak menghentikan interval saat status final. `poll()` melakukan `return` sebelum `setAttempts`, sehingga interval 3 detik terus berjalan; tiap respons `setOrder(result.data)` membuat objek baru, dan effect `[isPaid, order]` fire ulang `trackAuthoritativeTikTokPurchase` setiap ±3 detik selama halaman terbuka (`app/checkout/payment-finish/payment-finish-content.tsx:111-134,175-200`).
- Server tidak pernah menggandakan event karena CAS.

### 6.4 Apakah event bisa terkirim sebelum pembayaran valid?

- Tidak dari alur normal: ketiga jalur browser mensyaratkan `PAID` (atau COD live), dan server hanya setelah CAS.
- **Batas keamanan browser**: siapa pun dapat memanggil `fbq`/`ttq` dari devtools. Purchase berbasis browser **tidak dapat diverifikasi** oleh platform. Ini alasan utama CAPI (server) lebih dipercaya, tetapi CAPI **di luar scope fase ini**.

### 6.5 Bagaimana nilai transaksi dipastikan?

- `total` diambil dari `order.total` (Prisma `Decimal`) dan dikonversi dengan `Number()` di server component/page (`success/page.tsx:204`), atau dari `PaymentView.amount` yang dibangun server (`lib/payment/order-payment.ts:129`).
- Item dari `order.items` (DB), bukan dari state checkout/client.
- Tidak ada perhitungan ulang total di client.

### 6.6 Apakah tersedia `event_id` untuk deduplication?

Ya — `ttq:completepayment:<orderNumber>` (`lib/analytics/tiktok.ts:256`, dipakai `PurchaseTracker.tsx:102` dan `tiktok-events-api.ts:624`). Untuk Meta nanti, gunakan pola setara `meta:purchase:<orderNumber>`.

### 6.7 Penanganan pending / failed / expired / cancelled

| Status | Purchase browser | Purchase server | Referensi |
|---|---|---|---|
| `PENDING` / `PROCESSING` | Tidak | Tidak (belum CAS) | success page gate, webhook CAS |
| `FAILED` / `EXPIRED` | Tidak | Tidak | `success/page.tsx:170-176`, `payment/[id]:188` |
| `CANCELLED` | Tidak (COD dikecualikan) | Tidak | `success/page.tsx:172-176` |
| `REFUNDED` | Tidak (COD dikecualikan) | Tidak ada event refund sama sekali | idem |
| `PAID` | Ya | Ya (sekali) | idem |

Catatan: order yang sudah `PAID` lalu di-refund **tidak** mengirim event pembatalan/refund. Jika Meta membutuhkan refund signal, itu fitur baru (di luar scope).

---

## 7. Security and Performance Findings

### 7.1 Validasi Pixel ID

- **Kuat.** Regex `^[A-Z0-9]{10,30}$` menolak spasi, kutip, `<`, `>`, `/`, `:`, dan karakter JS (`lib/analytics/tiktok.ts:43`).
- Normalisasi + validasi dilakukan di **server** saat simpan (`app/api/admin/settings/route.ts:530-570`), bukan hanya client.
- Meta Pixel ID berbeda format: **15–16 digit angka**. Validator terpisah wajib dibuat (`/^\d{15,16}$/`); jangan memakai ulang regex TikTok.

### 7.2 Perlindungan endpoint admin

- `GET`/`PUT` memerlukan sesi `ADMIN` (`route.ts:271-283,326-345`), ditambah guard proxy (`proxy.ts`).
- Tidak ada rate limit khusus pada endpoint settings; dampaknya rendah karena ADMIN-only.
- Token akses TikTok tidak pernah diserialisasi: tidak ada di `SETTINGS_SELECT`, hanya flag `configured` + `last4` (`route.ts:112-170`).

### 7.3 Risiko script injection / XSS

| Temuan | Level | Detail |
|---|---|---|
| Admin dapat menempel **JavaScript mentah** (`tiktokPixelCode`) yang dieksekusi inline di storefront | **HIGH (pre-existing, accepted by design)** | `app/api/admin/settings/route.ts:419-500`, `components/analytics/TikTokPixel.tsx:60-70`, `lib/analytics/tiktok-pixel-code.ts` (tidak melakukan sanitasi JS) |
| CSP `script-src 'unsafe-inline'` | **MEDIUM** | Diperlukan oleh kode inline TikTok/Next; melemahkan pertahanan XSS (`next.config.ts:87-95`) |
| `pixelId` disisipkan sebagai atribut `data-pixel-id` | **LOW** | React meng-escape atribut; regex juga membatasi karakter |
| Warning mismatch ID tidak memblokir simpan | **LOW** | `app/api/admin/settings/route.ts:1056`; admin tetap pemutus |

**Keputusan desain untuk Meta:** jangan mengulang pola "tempel JavaScript". Admin hanya memasukkan **Meta Pixel ID**; snippet dibangun aplikasi dari ID yang sudah tervalidasi. Ini menghilangkan kelas risiko ini untuk Meta.

### 7.4 Environment variables

- Pixel ID/config tracking **tidak** memakai env; hanya `TIKTOK_TEST_EVENT_CODE`.
- Tidak ada `NEXT_PUBLIC_*` untuk pixel.
- Meta tidak memerlukan env untuk browser-only (tanpa CAPI). Jika CAPI ditambahkan nanti, token harus server-only dan **tidak** masuk `SETTINGS_SELECT` (mengikuti pola Access Token TikTok).

### 7.5 Client vs Server Component & kompatibilitas Next.js

- Pola sudah benar: Server Component membaca DB (`AnalyticsProvider`), Client Component hanya menerima props yang diperlukan dan merender `next/script`.
- `TikTokPixel` memakai `usePathname()` (client) untuk mengecualikan `/admin`; root layout tetap server.
- `next/script` `afterInteractive` adalah cara yang tepat untuk Next 16 App Router; tidak ada `document.write` atau injeksi manual.
- Kompatibel dengan React 19 Strict Mode karena guard memakai `ref`, bukan state.

### 7.6 CSP

- `script-src`: `'self'`, `'unsafe-inline'`, `https://analytics.tiktok.com` (`next.config.ts:34-39`).
- `connect-src`: `'self'`, `https://analytics.tiktok.com` (`:44-47`).
- `img-src`: `'self'`, Cloudinary/Supabase, unpkg, OSM, iPaymu, `data:` (`:105`).
- **Tidak ada** `connect.facebook.net`, `www.facebook.com`, `facebook.com`.
- **Dampak:** tanpa perubahan CSP, Meta Pixel akan gagal memuat `fbevents.js` dan beacon `/tr` akan diblokir — pixel tampak "aktif" di admin tetapi tidak menghasilkan data. Ini **blocker implementasi**, bukan bug runtime saat ini.
- Test `__tests__/security/m4-csp.test.ts` menegaskan tidak ada wildcard di `connect-src`; penambahan origin eksplisit Meta tetap lolos, tetapi test perlu diperluas.

### 7.7 Cookie consent / izin tracking

- **Tidak ada mekanisme consent apa pun** (tidak ada banner, context, localStorage flag, maupun endpoint). Pencarian `consent` hanya menemukan daftar method di file test TikTok.
- Artinya: TikTok Pixel **sudah** berjalan untuk semua pengunjung tanpa consent. Menambahkan Meta akan memperluas perilaku yang sama.
- Requirement "tracking hanya berjalan bila memenuhi ketentuan consent yang berlaku" **belum dapat dipenuhi** tanpa keputusan produk/hukum. Opsi ada di §8.6.

### 7.8 Potensi script dimuat berulang

- Script TikTok di-mount sekali di root layout dengan `id` stabil; navigasi SPA tidak me-remount root layout.
- Namun **admin dapat menempel base code yang memuat `ttq.load()` lebih dari sekali** (tidak ada guard); tidak ada validasi duplikasi.
- Untuk Meta, snippet akan dibangun aplikasi (bukan admin), sehingga hanya ada satu `fbq('init')`. Tetap gunakan `id="meta-pixel-base"` dan render sekali.

### 7.9 Performa

- 1 query `StoreSetting` per render layout (di-cache oleh Next + `revalidatePath` saat simpan).
- Script TikTok dimuat `afterInteractive`, tidak memblokir render pertama.
- Menambah Meta berarti +1 request eksternal (`connect.facebook.net`, ±70–100 KB) dan beacon tambahan. Dampak ke LCP/INP kecil karena `afterInteractive`, tetapi tetap perlu diukur setelah implementasi.
- **Rekomendasi:** gabungkan pembacaan konfigurasi TikTok + Meta dalam satu query/`select`, atau satu fungsi `getTrackingConfig()`, agar tidak menjadi dua query terpisah per render.

---

## 8. Meta Pixel Proposed Architecture

### 8.1 Prinsip

1. **ID-only configuration** — tidak ada kolom kode JavaScript, tidak ada Access Token di fase ini.
2. **Server-resolved config → client render** — mengikuti pola `AnalyticsProvider`/`TikTokPixel`.
3. **Application-controlled PageView** — snippet Meta **tidak** memanggil `fbq('track','PageView')`; PageView dikirim tracker aplikasi sekali per navigasi. Ini mencegah double PageView (penyebab paling umum "2× PageView" pada Meta Pixel).
4. **Additive** — tidak mengubah payload/logika TikTok, tidak mengubah checkout/payment gateway.
5. **Fail-closed** — kolom belum ada / ID tidak valid / integrasi nonaktif ⇒ tidak ada script, tidak ada event.
6. **Tanpa CAPI** di fase awal; `eventID` tetap dikirim agar CAPI dapat ditambahkan nanti tanpa mengubah kontrak event.

### 8.2 Model konfigurasi

```ts
// lib/analytics/meta.ts (client-safe)
export type MetaPixelConfig = {
  enabled: boolean;
  pixelId: string | null;
};
export const META_PIXEL_ID_PATTERN = /^\d{15,16}$/;
```

- `normalizeMetaPixelId()`: trim, buang spasi, validasi regex.
- `buildMetaEventId(event, reference)` → `meta:<event>:<reference>` (lowercase event, reference trim).
- `trackMetaEvent(event, params?, options?)`: guard `typeof window.fbq === "function"`; **tidak** membuat stub sendiri.

### 8.3 Alur runtime

```
app/layout.tsx
  └─ <AnalyticsProvider /> (Server Component)
       ├─ getTrackingConfig()          ← satu query StoreSetting
       │    ├─ TikTok (existing, tidak berubah)
       │    └─ Meta   (baru, fail-closed)
       ├─ <TikTokPixel />              ← existing
       ├─ <MetaPixel enabled pixelId /> ← BARU: next/script id="meta-pixel-base"
       ├─ <MetaPageViewTracker enabled /> ← BARU: sekali per pathname+search
       └─ ... existing TikTok components
```

Snippet yang dibangun (inline, `afterInteractive`):

```js
!function(f,b,e,v,n,t,s){/* standar Meta */}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '<PIXEL_ID>');
// SENGAJA TANPA fbq('track','PageView')
```

- `PIXEL_ID` disisipkan hanya setelah validasi regex (defense-in-depth: validasi ulang di komponen).
- `<noscript><img src="https://www.facebook.com/tr?id=<id>&ev=PageView&noscript=1"/></noscript>` boleh disertakan: hanya aktif saat JS mati, sehingga tidak menduplikasi tracker aplikasi. Ini membutuhkan `img-src https://www.facebook.com`.
- Route `/admin` dikecualikan (reuse `isAdminPath`, `lib/analytics/tiktok.ts:311`).

### 8.4 Pemetaan event Meta

| Meta event | Sumber data existing | Payload |
|---|---|---|
| `PageView` | navigasi | tanpa parameter; tanpa `eventID` (tidak ada pasangan server) |
| `ViewContent` | `ProductDetail` | `content_ids: [productId]`, `content_type: "product"`, `content_name`, `value` (unit price), `currency: "IDR"` |
| `AddToCart` | `ProductDetail` setelah cart sukses | + `contents:[{id, quantity, item_price}]`, `value = price × qty` |
| `InitiateCheckout` | `CheckoutPage` / `BuyNowPage` | `contents[]`, `num_items`, `value` = subtotal server, `currency` |
| `AddPaymentInfo` | submit order | idem + `payment_method` (opsional) |
| `Purchase` | 3 jalur browser existing | `value` = `Order.total`, `currency: "IDR"`, `order_id` = `orderNumber`, `contents[]`, `num_items`, `eventID = meta:purchase:<orderNumber>` |

Catatan: Meta memakai `contents[].id` + `item_price` + `quantity`; jangan mengirim `content_id` (nama field TikTok). Buat builder terpisah (`lib/analytics/meta-catalog.ts`) yang membaca **objek item yang sama** dari call site, bukan membangun ulang dari sumber berbeda.

### 8.5 Deduplication & anti-duplikasi

1. `eventID` deterministik untuk `Purchase` (wajib).
2. `useRef` guard per mount pada komponen purchase (sudah menjadi pola `completedTracked` di `payment/[id]:73`).
3. Guard tambahan `sessionStorage` per `orderNumber` untuk mencegah emission berulang saat reload — dengan konsekuensi: bila event pertama diblokir adblock, tidak ada retry. Trade-off ini harus disetujui.
4. **Jangan** mengirim `Purchase` dari halaman checkout atau dari `AddPaymentInfo`.
5. Perbaiki (opsional, direkomendasikan) perilaku polling `payment-finish` agar berhenti saat final — ini juga mengurangi beban dan duplikasi TikTok.

### 8.6 Consent (keputusan yang diperlukan)

Karena belum ada mekanisme consent, ada tiga opsi:

- **Opsi A (paling kecil):** gunakan toggle `metaPixelEnabled` sebagai satu-satunya gate, sama seperti TikTok. Tidak memenuhi persyaratan consent eksplisit; risiko kepatuhan (UU PDP) tetap ada.
- **Opsi B (disarankan bila target audiens ID/EU):** tambahkan gate consent minimal (localStorage + banner) dan hanya muat script bila `enabled && consent === "granted"`. Ini perubahan produk/UI baru, di luar "reuse existing architecture", dan harus disetujui.
- **Opsi C (sementara):** implementasi Meta di balik flag `enabled` yang **default false**, dan jangan aktifkan sampai mekanisme consent ada. Implementasi teknis selesai, aktivasi ditunda.

### 8.7 Yang **tidak** dilakukan di fase ini

- Meta Conversions API / server-side events (tidak ada token, tidak ada endpoint, tidak ada dedup lintas channel).
- Menyimpan JavaScript mentah Meta dari admin.
- Mengubah checkout, pembuatan order, webhook, atau status pembayaran.
- Refactor TikTok Pixel.

---

## 9. File-by-file Implementation Plan

### 9.1 File baru

| File | Isi |
|---|---|
| `prisma/migrations/20261021000000_add_meta_pixel/migration.sql` | `ALTER TABLE storesetting ADD metaPixelEnabled, metaPixelId` (lihat §10) |
| `lib/analytics/meta.ts` | Tipe config, regex ID 15–16 digit, normalize, `buildMetaEventId`, deklarasi `window.fbq`, `trackMetaEvent`, `isMetaPixelReady` |
| `lib/analytics/meta-config.ts` | `getMetaPixelConfig()` server-only: satu query `StoreSetting`, fail-closed, tidak pernah mengembalikan nilai sensitif |
| `lib/analytics/meta-catalog.ts` | Builder payload Meta: `buildMetaProductParams`, `buildMetaCartParams`, `buildMetaPurchaseParams` (currency IDR, contents, item_price, num_items) |
| `components/analytics/MetaPixel.tsx` | Client Component, `next/script` `id="meta-pixel-base"` `afterInteractive`, snippet init tanpa PageView, skip `/admin`, validasi ulang ID |
| `components/analytics/MetaPageViewTracker.tsx` | PageView sekali per `pathname+search`, menunggu pixel ready, tanpa `eventID` |
| `__tests__/security/meta-pixel.test.ts` | Validasi ID, config fail-closed, tidak ada kolom kode mentah, script tidak memuat PageView |
| `__tests__/security/meta-events.test.ts` | Payload ViewContent/AddToCart/InitiateCheckout/Purchase, IDR, tidak ada nilai fiktif |
| `__tests__/security/meta-purchase-dedup.test.ts` | `eventID` stabil, tidak ada Purchase tanpa PAID, guard reload |

### 9.2 File yang dimodifikasi

| File | Perubahan | Risiko |
|---|---|---|
| `prisma/schema.prisma` | Tambah `metaPixelEnabled Boolean @default(false)`, `metaPixelId String?` di `StoreSetting` | Rendah (additive) |
| `lib/admin/audit-log.ts` | Tambah `"META_PIXEL_UPDATED"` ke union `AuditAction` (`:15-80`) | Rendah |
| `app/api/admin/settings/route.ts` | `SETTINGS_SELECT`, tipe proyeksi, `toSettingsResponse`, validasi/normalisasi Meta, `create` + `update` upsert, audit log | **Sedang** — dua tempat upsert harus konsisten |
| `app/admin/settings/AdminSettingsForm.tsx` | `StoreForm`, `initialForm`, `loadSettings`, validasi, section UI "Meta Pixel" setelah section TikTok (`:2009`) | Sedang (file besar, 3.267 baris) |
| `components/analytics/AnalyticsProvider.tsx` | Panggil `getMetaPixelConfig()`, render `MetaPixel` + `MetaPageViewTracker` | Rendah |
| `next.config.ts` | `script-src` + `https://connect.facebook.net`; `connect-src` + `https://www.facebook.com`; `img-src` + `https://www.facebook.com` | Rendah, tetapi **wajib** agar pixel berfungsi |
| `components/analytics/PurchaseTracker.tsx` | Di dalam `trackAuthoritativeTikTokPurchase` (satu-satunya jalur 3 halaman purchase), tambahkan `trackMetaPurchase(...)` dengan data yang sama | Sedang — jangan ubah payload TikTok; tambahkan setelah `trackTikTokEvent` |
| `components/products/ProductDetail.tsx` | Tambah `trackMetaEvent("ViewContent"/"AddToCart", buildMeta...)` di samping call TikTok yang ada | Sedang (2 call site) |
| `app/checkout/CheckoutPage.tsx` | Tambah Meta `InitiateCheckout` + `AddPaymentInfo` | Sedang |
| `app/buy-now/BuyNowPage.tsx` | Tambah Meta `InitiateCheckout` + `AddPaymentInfo` | Sedang |
| `app/checkout/payment-finish/payment-finish-content.tsx` | (Opsional) hentikan polling saat final + ref guard purchase | Rendah, memperbaiki HIGH existing |
| `__tests__/security/m4-csp.test.ts` | Tambah assertion origin Meta eksplisit, tetap tanpa wildcard | Rendah |
| `__tests__/security/tiktok-pixel.test.ts` | Kemungkinan perlu penyesuaian bila mengunci bentuk `SETTINGS_SELECT`/respons settings | Rendah |
| `docs/META-PIXEL-INTEGRATION-AUDIT.md` | Laporan ini | — |

### 9.3 Alternatif yang ditolak

- **Menyimpan Meta base code mentah dari admin** — memperluas risiko arbitrary JS dan tidak diperlukan karena snippet Meta deterministik dari Pixel ID.
- **Mengirim PageView dari snippet Meta** — menyebabkan double PageView bersama tracker aplikasi.
- **Memakai `event_id` TikTok untuk Meta** — ID harus unik per platform; gunakan prefix `meta:`.
- **Menambahkan Meta CAPI sekarang** — butuh token, verifikasi domain, dan strategi dedup; di luar persetujuan.

---

## 10. Database Migration Requirements

### 10.1 Perubahan schema

```prisma
// prisma/schema.prisma — model StoreSetting
// Meta Pixel (browser-only; tidak ada token/kode mentah)
metaPixelEnabled Boolean @default(false)
metaPixelId      String?
```

```sql
-- prisma/migrations/20261021000000_add_meta_pixel/migration.sql
ALTER TABLE `storesetting`
  ADD COLUMN `metaPixelEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `metaPixelId` VARCHAR(191) NULL;
```

### 10.2 Karakteristik & kompatibilitas

| Aspek | Penilaian |
|---|---|
| Tipe perubahan | **Additive** (2 kolom baru; tidak ada rename/drop) |
| Default | `metaPixelEnabled` default `false` ⇒ semua toko nonaktif sampai admin mengaktifkan |
| Backfill | **Tidak diperlukan** |
| Locking | MySQL 8 `ADD COLUMN` dengan default konstan umumnya instant/online; tetap jalankan di jendela maintenance untuk aman |
| Kompatibilitas kode lama | Kode lama tidak memilih kolom baru ⇒ aman |
| Kompatibilitas kode baru dengan DB lama | `getMetaPixelConfig()` **wajib** menangkap error (mis. Prisma `P2022`) dan mengembalikan config disabled, seperti `getTikTokPixelConfig()` (`lib/analytics/tiktok-config.ts:96-104`) |
| Urutan deploy | **Migration dulu, lalu deploy kode.** Jika kode baru lebih dulu, `PUT /api/admin/settings` akan error karena Prisma menulis kolom yang belum ada |
| Rollback | `ALTER TABLE storesetting DROP COLUMN metaPixelEnabled, DROP COLUMN metaPixelId;` — hanya kehilangan konfigurasi Meta, tidak ada data transaksi |
| Risiko | **LOW** |

### 10.3 Tidak ada migration lain

Tidak perlu tabel event, outbox, atau kolom `event_id`. Dedup Meta sepenuhnya berbasis `orderNumber` yang sudah ada (`Order.orderNumber @unique`).

---

## 11. Risk Assessment

| # | Risiko | Level | Dampak | Mitigasi |
|---|---|---|---|---|
| R1 | CSP memblokir `connect.facebook.net` / `www.facebook.com` | **HIGH** | Pixel tidak memuat data sama sekali | Update `next.config.ts` + test CSP sebelum aktivasi |
| R2 | Tidak ada consent mechanism | **HIGH** | Potensi pelanggaran UU PDP/GDPR; requirement #4 tidak terpenuhi | Keputusan Opsi A/B/C (§8.6); default `metaPixelEnabled = false` |
| R3 | `PUT` settings menimpa/mengabaikan field Meta bila tidak ditangani di create **dan** update | **HIGH** | Konfigurasi Meta hilang setiap simpan pengaturan | Implementasi kedua blok upsert + test round-trip |
| R4 | Duplikasi emission Purchase di `payment-finish` (existing) | **HIGH** | Event berulang tiap 3 detik; membebani platform dan berpotensi double-count bila `eventID` lupa | Perbaiki interval + ref guard; Meta wajib `eventID` |
| R5 | Browser-only Purchase (tanpa CAPI) | **MEDIUM** | Kehilangan konversi dari adblock/iOS/ITP; tidak ada rekonsiliasi server | Dokumentasikan; CAPI fase berikutnya bila disetujui |
| R6 | Double PageView bila snippet Meta memuat `fbq('track','PageView')` | **MEDIUM** | Metrik page view 2× | Snippet init-only + tracker aplikasi; test source-scan |
| R7 | JS mentah admin (TikTok) sebagai preseden | **MEDIUM** | Risiko XSS diterima pada TikTok; jangan diperluas ke Meta | Meta hanya ID; CSP tetap |
| R8 | Dua query `StoreSetting` per render layout | **LOW** | Sedikit overhead DB | Gabungkan query/fungsi config |
| R9 | Race/deploy ordering migration vs app | **LOW** | Error simpan settings bila urutan salah | Migration dulu; config reader fail-closed |
| R10 | Tidak ada audit action Meta | **LOW** | Perubahan konfigurasi tidak tercatat | Tambah `META_PIXEL_UPDATED` |
| R11 | Meta Pixel ID salah format diterima | **LOW** | Script gagal init | Regex 15–16 digit di client + server |
| R12 | `eventID` tidak cukup untuk reload berulang di luar window dedup | **LOW** | Double-count bila user reload setelah window | Guard `sessionStorage` (opsional) |
| R13 | Payload Meta berbeda dari TikTok (field `contents` vs `content_id`) | **LOW** | Data katalog tidak match | Builder terpisah + unit test |
| R14 | Test suite lama mengunci bentuk respons settings | **LOW** | CI gagal setelah penambahan field | Perbarui assertion, jangan melemahkan test |

---

## 12. Testing Strategy

### 12.1 Unit (tanpa jaringan)

1. `normalizeMetaPixelId`: menerima 15/16 digit; menolak huruf, spasi, `<script>`, string kosong, 14/17 digit.
2. `buildMetaEventId`: deterministik, prefix `meta:`, tidak memuat PII.
3. `getMetaPixelConfig`: disabled saat `enabled=false`, ID invalid, query error (`P2022`), dan tidak pernah mengembalikan kode/token.
4. Builder payload: `contents[].id` = `productId`, `item_price` = harga satuan, `quantity` integer, `value` = total, `currency = "IDR"`; field tidak tersedia **diomit**, bukan diisi 0.
5. `trackMetaEvent`: no-op bila `window.fbq` tidak ada; tidak membuat stub; meneruskan `eventID` sebagai argumen ketiga.

### 12.2 Integrasi / source-scan

1. `MetaPixel` tidak dirender saat disabled dan di `/admin`; `id="meta-pixel-base"` hanya satu.
2. Snippet tidak mengandung `fbq('track','PageView')`.
3. `PurchaseTracker` mengirim `Purchase` hanya lewat jalur yang sudah di-gate; tidak ada pemanggilan `Purchase` di halaman checkout.
4. `AnalyticsProvider` tetap merender semua komponen TikTok (regresi TikTok = 0).
5. `m4-csp.test.ts`: origin Meta ada eksplisit, tidak ada wildcard, `unsafe-eval` tetap absen di production.

### 12.3 Regression TikTok (wajib)

- Jalankan suite TikTok yang ada (minimal): `tiktok-pixel`, `tiktok-attribution`, `tiktok-advanced-matching`, `tiktok-matching-coverage`, `tiktok-payment-purchase-identity`, `tiktok-purchase-identity`, `tiktok-pageview`, `tiktok-event-value`.
- Tidak boleh ada perubahan snapshot/payload TikTok.

### 12.4 Manual (setelah approval, non-production)

- Meta Pixel Helper di storefront: PageView tepat 1× per navigasi; ViewContent/AddToCart/InitiateCheckout/Purchase muncul dengan `IDR` dan `content_ids`.
- Buka `/admin/settings`: pixel **tidak** dimuat.
- Simulasi pembayaran sandbox: Purchase hanya setelah `PAID`; refresh halaman tidak menambah konversi (cek Events Manager).
- **Dilarang** mengirim test event ke platform production selama audit; test event hanya dengan persetujuan dan environment non-production.

### 12.5 Yang tidak diuji di fase audit

Tidak ada test yang dijalankan pada fase ini (audit statis). Tidak ada migration dijalankan. Tidak ada event dikirim.

---

## 13. Recommended Implementation Phases

| Fase | Isi | Gate |
|---|---|---|
| **0. Approval** | Setujui laporan, pilihan consent (A/B/C), dan perubahan CSP | **Wajib sebelum kode** |
| **1. Schema** | Migration additive + `prisma generate`; verifikasi `migrate status` | Review SQL |
| **2. Config & Admin** | `meta.ts`, `meta-config.ts`, API settings, form UI, audit action, test round-trip | Test admin settings + tidak ada regresi TikTok |
| **3. Base Pixel** | `MetaPixel` + `MetaPageViewTracker` + CSP + test CSP | Pixel Helper: 1× PageView |
| **4. E-commerce events** | ViewContent, AddToCart, InitiateCheckout, AddPaymentInfo (call site additive) | Payload sesuai data DB |
| **5. Purchase** | `trackMetaPurchase` di jalur purchase existing + `eventID` + guard; opsional perbaikan polling `payment-finish` | Uji PAID/PENDING/FAILED/EXPIRED |
| **6. Verification** | Regression TikTok, typecheck, lint, build, uji manual sandbox | Semua gate hijau |
| **7. (Terpisah)** | Meta CAPI — **hanya bila disetujui** | Butuh desain dedup & token server |

Estimasi perubahan: 1 migration, ±6 file baru, ±9 file dimodifikasi, 3 file test baru + 2 test diperbarui.

---

## 14. Final Readiness Status

### **CONDITIONAL GO**

**Alasan:**

- Arsitektur TikTok Pixel sudah menjadi pola yang jelas, teruji, dan dapat ditiru: config di DB, server-resolved, client-rendered, event ter-gate, dedup berbasis `orderNumber`.
- Meta Pixel **tidak memerlukan perubahan business logic checkout maupun payment gateway**. Semua data transaksi yang dibutuhkan sudah tersedia dan authoritative di `Order`/`OrderItem`.
- Perubahan database bersifat additive dan berisiko rendah.
- Tidak ada dependency baru yang diperlukan (snippet Meta dimuat dari CDN, bukan npm).

**Kondisi yang harus dipenuhi sebelum implementasi (semua wajib):**

1. **Persetujuan migration** dua kolom `StoreSetting` (§10).
2. **Persetujuan perubahan CSP** untuk `connect.facebook.net` dan `www.facebook.com` (§7.6).
3. **Keputusan consent** (Opsi A/B/C — §8.6), karena requirement #4 belum dapat dipenuhi dengan mekanisme yang ada.
4. **Persetujuan penambahan pemanggilan Meta secara additive** di 8 file call-site, termasuk `PurchaseTracker.tsx`, dengan jaminan payload TikTok tidak berubah.
5. **Konfirmasi CAPI tetap di luar scope** fase awal (browser-only, dengan konsekuensi coverage).

**Yang membuat status ini bukan READY:** CSP blocker, ketiadaan consent, dan migration yang belum disetujui.

**Yang membuat status ini bukan BLOCKED:** tidak ada hambatan arsitektural; seluruh kebutuhan data dan pola implementasi sudah tersedia di codebase.

---

### Lampiran A — Ringkasan referensi kunci

| Topik | Referensi |
|---|---|
| Schema StoreSetting | `prisma/schema.prisma:605-659` |
| Config TikTok (server) | `lib/analytics/tiktok-config.ts:27-110` |
| Validasi/normalisasi ID | `lib/analytics/tiktok.ts:43,276-305` |
| Analisis kode pixel | `lib/analytics/tiktok-pixel-code.ts:85,179,209,263` |
| Pemasangan script | `components/analytics/TikTokPixel.tsx:31-70` |
| Provider | `components/analytics/AnalyticsProvider.tsx:31-60`; `app/layout.tsx:113` |
| PageView | `components/analytics/TikTokPageViewTracker.tsx:91-106` |
| Katalog/payload | `lib/analytics/tiktok-catalog.ts:57,101,198,246,316,379,429` |
| Purchase browser | `components/analytics/PurchaseTracker.tsx:41-105` |
| Gate halaman sukses | `app/checkout/success/page.tsx:158-215` |
| Gate halaman pembayaran | `app/checkout/payment/[id]/page.tsx:187-215` |
| Payment finish (dup risk) | `app/checkout/payment-finish/payment-finish-content.tsx:111-134,175-200` |
| Webhook Midtrans | `app/api/payment/midtrans/notification/route.ts:407-512` |
| Webhook iPaymu | `app/api/payment/ipaymu/notification/route.ts:473-581` |
| Server Events API | `lib/analytics/tiktok-events-api.ts:605-645` |
| Settings API | `app/api/admin/settings/route.ts:44-170,271-345,419-580,750-1070` |
| Admin form | `app/admin/settings/AdminSettingsForm.tsx:32-200,531-615,1561-1670,2009-2320` |
| Guard admin | `app/admin/settings/page.tsx:14-30`; `proxy.ts:18-25,60-70` |
| CSP | `next.config.ts:27-110` |
| Audit action | `lib/admin/audit-log.ts:15-80` |
| Test CSP | `__tests__/security/m4-csp.test.ts` |
| Test pixel TikTok | `__tests__/security/tiktok-pixel.test.ts` |
