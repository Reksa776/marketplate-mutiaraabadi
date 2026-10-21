# META PIXEL — PRE-IMPLEMENTATION REVIEW

**Dokumen ini adalah review korektif, bukan laporan audit awal.**
Laporan awal tetap utuh di `docs/META-PIXEL-INTEGRATION-AUDIT.md` dan **tidak ditimpa**.

| Item | Nilai |
|---|---|
| Tanggal review | 21 Oktober 2026 |
| Baseline commit | `099f9af` (2026-10-19) |
| Dokumen yang direview | `docs/META-PIXEL-INTEGRATION-AUDIT.md` |
| Metode | Pembacaan kode aktual + verifikasi dokumentasi resmi Meta + verifikasi statis migration history |
| Perubahan source code | **Tidak ada** |
| Migration dijalankan | **Tidak** |
| Deployment | **Tidak** |
| Tracking event dikirim | **Tidak** |
| Perubahan konfigurasi TikTok | **Tidak** |
| Commit otomatis | **Tidak** |
| Keputusan akhir | **CONDITIONAL GO untuk implementasi; production activation BLOCKED sampai gate terpenuhi** |

> Catatan: working tree memiliki perubahan yang **sudah ada sebelum audit** (`app/api/payment/*/notification/route.ts`, `lib/admin/audit-log.ts`, `lib/payment/webhook-trace.ts`, `docs/order-cleanup/`, `scripts/order-cleanup/`). Tidak disentuh dan tidak menjadi bagian review ini.

**Batasan verifikasi:** review ini statis (kode + dokumentasi resmi). Tidak ada koneksi ke database, tidak ada migration/test yang dijalankan, dan duplicate polling tidak direproduksi di browser. Nama tabel fisik tidak dapat dipastikan dari repository (lihat §6) dan wajib diverifikasi di staging sebelum SQL final dijalankan.

---

## 0. Ringkasan Koreksi

| # | Koreksi yang diminta | Temuan review | Dampak terhadap laporan awal |
|---|---|---|---|
| C1 | Perbaikan duplicate polling `payment-finish` wajib sebelum aktivasi Meta Purchase | Terkonfirmasi: interval tidak berhenti saat status final; effect Purchase berjalan ulang tiap ±3 detik | Status berubah dari **opsional** menjadi **mandatory prerequisite** |
| C2 | Jangan asumsikan `eventID` mencegah semua duplicate browser events | Terkonfirmasi oleh dokumentasi Meta: dedup `eventID` hanya untuk pasangan Pixel ↔ Conversions API; **browser-only tidak dideduplikasi** | Strategi dedup harus memakai guard eksplisit, bukan `eventID` saja |
| C3 | Rancang shared consent TikTok + Meta, tanpa mengubah TikTok diam-diam | Belum ada consent mechanism; gate harus sebelum script dimuat; perubahan TikTok harus bertahap dan eksplisit | Desain consent baru + mode migrasi `legacy`/`enforced` |
| C4 | Verifikasi format Meta Pixel ID | Dokumentasi resmi Meta hanya menyatakan `id` = *numeric string*; **tidak ada kontrak panjang 15–16 digit** | Regex 15–16 digit dibatalkan |
| C5 | Audit risiko full-form PUT | Form mengirim seluruh state; API menulis seluruh kolom; tidak ada concurrency check | Risiko **HIGH**; perlu presence-semantics + optimistic concurrency |
| C6 | Verifikasi migration SQL terhadap tabel/provider/history | Provider MySQL; schema memetakan `storesetting`, tetapi baseline/3 migration awal memakai `StoreSetting` | Migration harus di-preflight ke DB staging; nama tabel tidak boleh diasumsikan |
| C7 | Pisahkan status implementasi/staging/produksi | Belum ada pemisahan gate | Tiga gate terpisah (§7) |
| C8 | Jangan klaim dedup lintas browser/server atau jaminan pengiriman Purchase | MVP browser-only tidak memiliki keduanya | Klaim dibatasi eksplisit (§8) |

**Tidak ada temuan `CRITICAL`.** Temuan `HIGH` yang tersisa: C1, C2, C3 (gap server-side), C5, C6.

---

## 1. C1 — Perbaikan Duplicate Polling `payment-finish` (Mandatory Prerequisite)

### 1.1 Bukti kode

`app/checkout/payment-finish/payment-finish-content.tsx`:

- Effect polling membuat interval 3 detik di `:111-129`.
- Di dalam `poll()`, status final melakukan `setLoading(false); return;` **sebelum** `setAttempts` (`:88-91`). Karena itu penghitung `attempts` tidak pernah mencapai `maxAttempts`, dan `clearInterval` di `:116-118` tidak pernah dieksekusi saat status sudah final.
- Setiap respons sukses memanggil `setOrder(result.data)` (`:70`). Objek baru membuat dependency effect Purchase `[isPaid, order]` (`:201`) berubah.
- Effect Purchase (`:175-201`) memanggil `trackAuthoritativeTikTokPurchase(...)` setiap kali dependency berubah, tanpa ref guard seperti di `app/checkout/payment/[id]/page.tsx:73,187-192`.

**Akibat:** selama halaman terbuka setelah `PAID`, Purchase browser dikirim ulang setiap ±3 detik. Ini bukan hanya risiko teoretis; ia terjadi pada route yang masih dapat diakses langsung (route ini `noindex` dan tidak ditemukan tautan internal ke sana, tetapi tetap hidup dan digunakan oleh `scripts/audit-ipaymu.ts:113-114`).

### 1.2 Mengapa ini wajib sebelum Meta Purchase

Untuk TikTok, duplikasi masih dapat tertahan oleh semantik `event_id` TikTok (tidak diverifikasi ulang di review ini). Untuk Meta, **tidak ada dedup browser-only** (lihat §2.1). Jika Meta Purchase ditambahkan tanpa memperbaiki bug ini, satu order dapat menghasilkan puluhan event Purchase di Events Manager.

### 1.3 Perbaikan yang harus disetujui

Perbaikan minimal, tanpa mengubah business logic:

1. Hentikan polling saat final: gunakan `isFinalRef`/`stopPolling()` yang dipanggil sebelum `return`, atau ubah ke `setTimeout` chain dengan guard final.
2. Jangan memanggil `poll()` di dalam state updater (`setAttempts`) — efek samping di updater dapat dieksekusi ganda oleh React Strict Mode.
3. Tambahkan `purchaseSentRef` per mount **dan** claim lintas mount (§2.3).
4. Ubah dependency effect Purchase menjadi `[isPaid, order?.orderNumber]` (bukan objek `order`), atau kirim hanya saat transisi `false → true`.
5. Tambahkan test dengan fake timers: 10 tick setelah `PAID` → tepat 1 pemanggilan track.

### 1.4 Gate aktivasi

**Meta Purchase tidak boleh diaktifkan (flag `metaPixelEnabled` tetap `false`) sampai:**

- perbaikan di atas merged dan test lulus; **atau**
- route `payment-finish` dihentikan/dialihkan secara permanen dan disetujui.

Perbaikan ini juga mengubah frekuensi event TikTok pada route tersebut (dari berulang menjadi sekali). Itu adalah bug fix, tetapi tetap **perubahan perilaku** yang harus disetujui eksplisit.

---

## 2. C2 — Strategi Purchase Deduplication (Re-evaluasi)

### 2.1 Dasar resmi Meta: `eventID` bukan dedup browser-only

Dokumentasi Meta “Handling Duplicate Pixel and Conversions API Events” menyatakan:

- Dedup `event_id` + `event_name` berlaku untuk **Meta Pixel dan Conversions API** yang mengirim event yang sama.
- “**Does not deduplicate events when only using one event source, that is browser-only or server-only. If you send us two consecutive browser events with the same information, we do not discard either.**”
- Dedup lintas channel pun dibatasi 48 jam.

Sumber: <https://developers.facebook.com/documentation/ads-commerce/conversions-api/deduplicate-pixel-and-server-events>

**Konsekuensi:** `eventID` tetap wajib dikirim (agar CAPI dapat ditambahkan nanti), tetapi **tidak boleh** diklaim sebagai pelindung duplicate browser. Guard harus eksplisit.

### 2.2 Matriks jalur duplikasi Purchase yang nyata

| Skenario | Perilaku saat ini | Risiko Meta |
|---|---|---|
| Reload halaman sukses | `PurchaseTracker` mount ulang, event dikirim lagi | **Duplicate** (Meta tidak dedup browser-only) |
| Remount React (Strict Mode / navigasi internal) | Effect berjalan lagi | **Duplicate** |
| `payment/[id]` → halaman sukses | Dua halaman berbeda mengirim Purchase untuk order yang sama | **Duplicate** |
| `payment-finish` polling | Kirim ulang tiap ±3 detik (C1) | **Duplicate parah** |
| Buka order yang sama di tab baru | Tidak ada state bersama | **Duplicate** |
| Buka di perangkat lain | Tidak ada state bersama | **Duplicate** |
| Adblock / script gagal | Tidak ada event | **Lost** (tidak ada retry) |
| Payment pending/failed/expired | Tidak ada event | Benar |

Catatan pemetaan: `InitiateCheckout` dan `AddPaymentInfo` **bukan** Purchase dan tidak boleh dikirim sebagai `Purchase`. Hanya status `PAID` (atau COD yang masih live) yang memenuhi syarat.

### 2.3 Desain guard berlapis (yang dapat diuji)

**Layer 1 — Server eligibility (sudah ada, dipertahankan)**
Hanya `PAID` (atau COD live) yang boleh memicu Purchase. Ini bukan dedup, tetapi mencegah false conversion.

**Layer 2 — Per-mount ref guard**
Seperti `completedTracked` di `app/checkout/payment/[id]/page.tsx:73`. Wajib ditambahkan ke `payment-finish` dan dipakai konsisten.

**Layer 3 — Cross-mount / cross-page claim (baru)**

Modul `lib/analytics/purchase-claim.ts`:

```ts
claimPurchase({
  channel: "meta" | "tiktok",
  pixelId: string,
  orderNumber: string,
}): boolean
```

- Key: `tracking:purchase:<channel>:<pixelId>:<orderNumber>`.
- Cek in-memory `Set` **dan** `sessionStorage`.
- Tulis claim secara sinkron **sebelum** memanggil `fbq`/`ttq`, hanya jika pixel API benar-benar tersedia.
- Bungkus `sessionStorage` dengan `try/catch` (mode privat / storage penuh) dan fallback ke in-memory.
- `pixelId` disertakan agar perubahan Pixel ID tidak memblokir event ke pixel baru.

Mengapa `sessionStorage`: bertahan pada reload dan perpindahan halaman dalam tab yang sama, tepat untuk tiga route Purchase yang ada. Guard ini **wajib diuji pada tiga kondisi: reload, remount, dan perpindahan halaman** (T1–T3). Tidak bertahan lintas tab/perangkat — lihat batasan di §2.5.

**Layer 4 — `eventID` deterministik**
`meta:purchase:<orderNumber>` dikirim sebagai argumen keempat `fbq('track', 'Purchase', params, { eventID })`. Fungsinya **hanya** menyiapkan pasangan Pixel ↔ CAPI di masa depan, bukan dedup browser.

### 2.4 Test matrix wajib

| Test | Aksi | Ekspektasi |
|---|---|---|
| T1 reload | Render → reload 3× order yang sama | 1 event Meta |
| T2 remount | Unmount/mount ulang komponen (Strict Mode) | 1 event |
| T3 navigasi | `payment/[id]` → `payment-finish` → `success` | 1 event total |
| T4 order berbeda | Dua order berbeda di tab yang sama | 2 event (satu per order) |
| T5 tab baru | Buka order yang sama di tab baru | **2 event** — known limitation (bisa 1 jika tab diduplikasi karena `sessionStorage` ikut tersalin), harus didokumentasikan |
| T6 script diblokir | `fbq` tidak tersedia | 0 event, claim tidak ditulis, tidak ada retry otomatis |
| T7 consent denied | Tidak ada consent | 0 event |
| T8 polling final | 10 tick setelah PAID | 1 event (C1) |
| T9 eventID | Semua jalur | String identik untuk order yang sama |
| T10 pixel ganti | Pixel ID berubah | Claim pixel lama tidak memblokir pixel baru |

### 2.5 Batasan yang harus diterima (bukan disembunyikan)

- **Tidak ada exactly-once lintas tab/perangkat** dengan `sessionStorage`. Jika ini kebutuhan bisnis, diperlukan **server-side claim**:
  - Tabel/kolom penanda, mis. `MetaPurchaseClaim(orderId, channel)` dengan unique constraint, atau kolom `metaPurchaseTrackedAt` pada `Order`.
  - Endpoint `POST /api/orders/[id]/tracking-claim` dengan otorisasi guest/session yang sudah ada.
  - Ini menambah migration + endpoint + perubahan alur, sehingga **di luar MVP** dan butuh approval terpisah.
- Bahkan dengan claim server, **pengiriman event ke Meta tetap tidak dijamin** (adblock, ITP, kegagalan jaringan).
- Claim ditulis sebelum `fbq` berarti event yang di-queue tetapi gagal terkirim tidak dikirim ulang. Ini trade-off yang dipilih untuk mencegah double-count; alternatif “retry” justru mengembalikan risiko duplicate.

---

## 3. C3 — Shared Consent Mechanism (TikTok + Meta)

### 3.1 Kondisi saat ini

- Tidak ada banner, cookie consent, localStorage flag, endpoint, atau halaman kebijakan privasi (pencarian `consent` hanya menemukan daftar method TikTok di file test).
- TikTok browser **dan** TikTok Events API server-side berjalan tanpa consent.
- Webhook mengirim `trackTikTokServerCompletePayment(...)` tanpa parameter consent (`app/api/payment/midtrans/notification/route.ts:512`, `app/api/payment/ipaymu/notification/route.ts:581`).
- Footer hanya menautkan FAQ, syarat & ketentuan, refund, kontak (`components/Footer.tsx:53-89`); tidak ada halaman privasi. `app/syarat-ketentuan/page.tsx:355-370` hanya menyebut “kebijakan privasi kami” tanpa tautan halaman.

### 3.2 Model consent yang diusulkan

**Penyimpanan (first-party):**
- Cookie `tracking_consent` = `granted` | `denied`; tidak ada nilai = `unset`.
- Atribut: `Path=/`, `SameSite=Lax`, `Secure` di HTTPS, `Max-Age=180 hari`.
- `httpOnly: false` agar banner dan event helper dapat membacanya; nilai bukan rahasia.
- Opsional: `tracking_consent_v` untuk versioning teks/ kebijakan.
- Helper baca cookie dapat memakai `readCookieValue()` yang sudah ada (`lib/analytics/attribution.ts:144-169`) di client, dan `cookies()` di server.

**Komponen:**
- `components/consent/ConsentProvider.tsx` — client context, state `"unset" | "granted" | "denied"`, method `grant()`, `deny()`, `reset()`.
- `components/consent/ConsentBanner.tsx` — dua tombol setara (Setujui / Tolak), tanpa pre-check, tanpa “implied consent”; tautan ke kebijakan privasi (perlu dibuat).
- `lib/consent/state.ts` — pure functions: parse/normalize/validasi nilai cookie, key storage.
- `lib/consent/read-server.ts` — `getTrackingConsent()` memakai `cookies()` (opsional, lihat trade-off).

**Gate:**
1. **Script loading** — `AnalyticsProvider` hanya merender komponen pixel jika consent memenuhi aturan channel.
2. **Event helpers** — `trackTikTokEvent()` dan `trackMetaEvent()` memeriksa consent sebelum memanggil API pixel (defense-in-depth; menangani consent yang dicabut setelah script termuat).
3. **Purchase** — claim + event hanya jalan jika consent granted.

### 3.3 Kapan consent diperiksa (sebelum script dimuat)

Dua opsi, dengan konsekuensi berbeda:

| Opsi | Cara | Kelebihan | Konsekuensi |
|---|---|---|---|
| **A. Server gate** | `cookies()` di `AnalyticsProvider`; script tidak dirender sama sekali bila belum granted | Paling ketat; tidak ada markup/script tracking di HTML | `cookies()` di root layout membuat **semua route dynamic** (dokumentasi Next: “Using it in a layout or page will opt a route into dynamic rendering” — `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md`) |
| **B. Client gate** | Komponen `TrackingGate` membaca cookie/localStorage saat mount; merender `next/script` hanya setelah granted | Tidak mengorbankan static rendering; script eksternal tidak di-fetch sebelum consent | String inline TikTok tetap ada di RSC payload (tidak dieksekusi); untuk kepatuhan paling ketat, opsi A lebih aman |

**Rekomendasi MVP: Opsi B**, dengan catatan tertulis bahwa inline code tetap terkirim ke browser. Jika kebijakan hukum mensyaratkan tidak ada script sama sekali sebelum consent, pilih Opsi A dan terima biaya dynamic rendering — keputusan ini harus eksplisit.

**Revocation:** script yang sudah dimuat tidak dapat “di-unload”. Setelah `deny()`, event helper berhenti mengirim; untuk menghapus script sepenuhnya perlu reload. Banner harus menjelaskan bahwa perubahan berlaku setelah reload.

### 3.4 Migrasi TikTok tanpa perubahan diam-diam

Gunakan mode eksplisit, bukan default tersembunyi:

```
TRACKING_CONSENT_MODE = legacy | enforced
```

| Mode | TikTok | Meta | Status |
|---|---|---|---|
| `legacy` (default rollout) | Sama seperti sekarang: gate hanya `tiktokPixelEnabled` | Wajib consent `granted` | Tidak ada perubahan perilaku TikTok |
| `enforced` | Wajib consent `granted` | Wajib consent `granted` | Perubahan eksplisit, harus disetujui + diumumkan |

Penyimpanan mode: environment variable server-only (tanpa `NEXT_PUBLIC_*`) **atau** kolom `StoreSetting`; keputusan ini harus disetujui. Nilainya tidak boleh dibaca oleh client bundle.

Aturan transisi:

1. **Fase T0** — kirim consent UI, penyimpanan, dan Meta (Meta default `false`). TikTok tetap `legacy`. Perilaku tracking TikTok tidak berubah; yang bertambah hanya banner/UI consent.
2. **Fase T1** — ukur consent rate dan event loss. Mode tetap `legacy`.
3. **Fase T2** — ubah ke `enforced` hanya dengan approval tertulis, setelah komunikasi ke pemilik toko. Rollback = kembalikan ke `legacy`.
4. **Jangan** memperlakukan “cookie belum ada” sebagai `granted` pada mode `enforced`. Itu akan mempertahankan tracking tanpa consent secara diam-diam.
5. **Jangan** mengubah `tiktokPixelEnabled` atau payload TikTok sebagai bagian dari pekerjaan consent.

**Konsekuensi yang harus disepakati:** saat `enforced`, pengunjung tanpa keputusan tidak dilacak TikTok sampai memilih. Ini akan menurunkan event TikTok; itu adalah efek yang diinginkan, bukan regresi.

### 3.5 Gap server-side TikTok Events API

Consent browser tidak otomatis menghentikan Events API server-side. Ada tiga opsi:

| Opsi | Dampak | Perubahan |
|---|---|---|
| **S1. Terima gap untuk MVP** | Events API tetap jalan tanpa consent; risiko kepatuhan didokumentasikan | Tidak ada, tetapi butuh risk acceptance tertulis |
| **S2. Persist consent di Order** | `Order.trackingConsent` diisi saat checkout; webhook hanya mengirim jika granted | Migration + perubahan checkout + webhook (di luar batas “tidak mengubah business logic”) |
| **S3. Nonaktifkan Events API server-side sementara** | Tidak ada event server TikTok; dedup lintas channel hilang | Perubahan perilaku TikTok, butuh approval |

**Rekomendasi:** S1 hanya jika pemilik toko menerima risiko; jika tidak, S2 menjadi prasyarat dan scope implementasi harus diperluas secara eksplisit. Jangan mengklaim bahwa consent browser mencakup Events API server-side.

### 3.6 Test consent wajib

- Belum ada cookie → tidak ada request ke `connect.facebook.net` / `analytics.tiktok.com` (mode `enforced`).
- `denied` → tidak ada request, tidak ada `fbq`/`ttq`, tidak ada event.
- `granted` → script dimuat tepat sekali; event berjalan.
- Grant → deny → event berhenti; reload menghapus script.
- Mode `legacy` → perilaku TikTok identik dengan baseline (source-scan + runtime).
- `/admin` → tidak ada script untuk kedua channel.
- Server gate (jika dipilih) → HTML tidak memuat tag script tracking.

---

## 4. C4 — Verifikasi Format Meta Pixel ID

### 4.1 Bukti

- Dokumentasi resmi Meta (Graph API, Ad Pixel) menyatakan field `id` adalah **“numeric string”**, tanpa jaminan panjang: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ads-pixel/>.
- Dokumentasi “Get started with the Meta Pixel” hanya menyebut “Pixel’s ID”; tidak menetapkan jumlah digit: <https://developers.facebook.com/documentation/meta-pixel/get-started/>.
- Klaim “15–16 digit” banyak muncul di artikel pihak ketiga, tetapi **bukan kontrak resmi** dan tidak boleh dijadikan hard validation.

### 4.2 Keputusan validasi

- **Hard rule:** hanya digit, panjang 1–32 karakter, setelah trim. Tidak ada spasi, `+`, `act_`, titik, atau karakter non-digit. Batas 32 adalah pengaman panjang/DoS, **bukan** klaim format resmi Meta.
- **Simpan sebagai string**, jangan `Number()`: ID 16 digit dapat melebihi `Number.MAX_SAFE_INTEGER` dan kehilangan presisi.
- UI boleh menyebut “Meta Pixel ID (Dataset ID)”; keduanya merujuk identifier numerik yang sama.
- **Soft warning** di admin jika panjang di luar 15–16: “Periksa kembali — umumnya 15–16 digit”, tetapi **tetap boleh disimpan**.
- Validasi di client **dan** server; server tetap sumber kebenaran.
- Tidak ada verifikasi ke Graph API pada fase ini (butuh token; di luar scope).

### 4.3 Test

- Menerima: `123456789012345`, `1234567890123456`, string 10 digit.
- Menolak: kosong, `abc`, `123 456`, `123-456`, `<script>`, 33 digit, `act_123`.
- Tidak mengubah nilai yang valid (preserve leading zeros).
- Warning tampil untuk panjang di luar 15–16 tanpa memblokir simpan.

---

## 5. C5 — Risiko Full-Form PUT terhadap Konfigurasi Meta

### 5.1 Bukti kode

- Form mengirim **seluruh** state: `body: JSON.stringify(form)` (`app/admin/settings/AdminSettingsForm.tsx:1729`).
- Tidak ada version/ETag yang dikirim atau diperiksa.
- API menulis **seluruh** kolom pada `update` (`app/api/admin/settings/route.ts:846-940`); nilai diambil dari body, mis. `tiktokPixelEnabled = body.tiktokPixelEnabled === true` (`:552`), `tiktokPixelId` (`:576`), dan seterusnya.
- `StoreSetting.updatedAt` ada (`prisma/schema.prisma:638`) tetapi **tidak** termasuk `SETTINGS_SELECT` (`app/api/admin/settings/route.ts:44-83`) maupun proyeksi respons (`:112-170`).
- `loadSettings()` memakai `cache: "no-store"` (`:531-540`), tetapi tidak ada mekanisme konflik.

### 5.2 Skenario overwrite

| # | Skenario | Hasil |
|---|---|---|
| S1 | Admin A membuka settings; Admin B mengaktifkan Meta; Admin A menyimpan alamat toko | Form A mengirim `metaPixelEnabled=false` / ID lama → **konfigurasi Meta tertimpa** |
| S2 | Tab admin dibiarkan terbuka melewati deploy; JS lama tidak mengirim field Meta | API memperlakukan field absen sebagai `false`/`null` → **Meta mati** |
| S3 | Klien API/script mengirim payload parsial | Field yang tidak dikirim menimpa nilai tersimpan |
| S4 | Request berhasil di DB tetapi respons gagal; admin retry dengan form lama | Overwrite nilai yang lebih baru |
| S5 | Dua admin menyimpan bersamaan | Last-write-wins, tanpa peringatan |
| S6 | GET settings gagal; form memakai nilai awal/default lalu disimpan | Nilai tersimpan tertimpa default |
| S7 | Validasi TikTok gagal (mis. `tiktokPixelEnabled` true tanpa code) | Perubahan Meta ikut gagal disimpan — coupling yang membingungkan |

Risiko ini **sudah ada untuk TikTok**, tetapi menambahkan Meta memperluas dampaknya. Level: **HIGH**.

### 5.3 Mitigasi yang harus disetujui sebelum implementasi

**Wajib (minimum):**

1. **Presence semantics** — update field Meta hanya jika key ada di body:
   - `hasOwn(body, "metaPixelEnabled")`, `hasOwn(body, "metaPixelId")`.
   - Field absen = **pertahankan nilai lama**, bukan `false`/`null`.
   - Penghapusan ID harus eksplisit: `clearMetaPixelId: true` (pola yang sama dengan `clearTiktokPixelAccessToken`).
2. **Jangan** memakai `=== true` untuk field yang mungkin absen.
3. **Disable save saat load gagal** — form hanya boleh disimpan setelah GET sukses (`settingsLoaded` flag).
4. **Audit log** mencatat perubahan per channel, tanpa nilai sensitif.

**Wajib sebelum production activation:**

5. **Optimistic concurrency**:
   - GET mengembalikan `settingsVersion` = `updatedAt.toISOString()`.
   - PUT menerima `expectedSettingsVersion`; bandingkan di dalam transaksi/`updateMany` dengan syarat `updatedAt`; jika 0 baris → **409 Conflict**.
   - UI menampilkan “pengaturan telah berubah di tab/perangkat lain”, memuat ulang, dan meminta admin menerapkan ulang. Jangan auto-merge diam-diam.
6. **Pisahkan endpoint tracking** (opsional tetapi disarankan): `PATCH /api/admin/settings/tracking` hanya untuk field tracking; PUT umum tidak lagi menulis field tracking. Ini mengurangi blast radius.
7. **Test**: stale-form simulation (dua GET, satu PUT di antaranya), 409 handling, absent-field preservation, explicit clear.

### 5.4 Catatan kompatibilitas

Menambahkan field Meta ke form lama yang di-cache dapat mengirim payload tanpa field Meta. Dengan presence semantics, payload lama **tidak** menghapus konfigurasi Meta. Tanpa presence semantics, deployment pertama dapat mematikan Meta setiap kali admin menyimpan dari tab lama.

---

## 6. C6 — Verifikasi Migration SQL

### 6.1 Fakta yang terverifikasi

| Aspek | Temuan | Referensi |
|---|---|---|
| Provider | **MySQL** | `prisma/schema.prisma:6-9`; `prisma/migrations/migration_lock.toml:3` |
| Nama tabel di schema | `storesetting` | `prisma/schema.prisma:657` (`@@map("storesetting")`) |
| Baseline | Membuat tabel **`StoreSetting`** (PascalCase) | `prisma/migrations/0_baseline/migration.sql:219` |
| Migration TikTok awal | `ALTER TABLE \`StoreSetting\`` | `20260819161137`, `20260819161955`, `20260819162211` |
| Migration setelahnya | `ALTER TABLE \`storesetting\`` | `20260922020000`, `20260922030000`, `20260924000000`, `20260928000000`, `20261001000000` |
| Migration terbaru | `20261013120000_whatsapp_autoreply_state` | `prisma/migrations/` |
| Urutan nama | Semua migration bernomor timestamp; nama baru harus sort setelah yang terbaru | — |

**Ini anomali nyata:** repository tidak konsisten antara `StoreSetting` dan `storesetting`. Pada MySQL, sensitivitas case tabel bergantung pada `lower_case_table_names`:
- `1` (umum di Windows/macOS): nama disimpan lowercase → `StoreSetting` dan `storesetting` adalah tabel yang sama.
- `0` (umum di Linux): keduanya **berbeda**; `ALTER TABLE storesetting` akan gagal jika tabel fisik bernama `StoreSetting`.

Karena migration lowercase setelah baseline tampaknya pernah dijalankan, ada dua kemungkinan: server memakai `lower_case_table_names=1`, atau tabel sudah di-rename di luar migration. **Tidak dapat dipastikan dari repository saja.**

### 6.2 Preflight wajib di staging (read-only)

```sql
SELECT table_name, table_collation
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND LOWER(table_name) = 'storesetting';

SHOW VARIABLES LIKE 'lower_case_table_names';
SELECT VERSION();
```

Dan:

```bash
npx prisma migrate status
```

`migrate status` hanya membaca riwayat; tidak menerapkan migration. Jangan jalankan `migrate dev`/`migrate reset` terhadap database production.

### 6.3 SQL yang diusulkan (nama tabel mengikuti hasil preflight)

```sql
-- Ganti `storesetting` dengan nama fisik yang terverifikasi jika berbeda.
ALTER TABLE `storesetting`
  ADD COLUMN `metaPixelEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `metaPixelId` VARCHAR(191) NULL;
```

- `BOOLEAN` adalah alias `TINYINT(1)` di MySQL; konsisten dengan migration TikTok (`20260922020000`).
- Tidak ada backfill; default `false`.
- Tidak ada index/unique constraint; ID bukan identifier internal.
- Migrasi ini hanya menambah kolom; tidak mengubah kolom TikTok, tidak menghapus data.

### 6.4 Urutan deploy & rollback

1. Backup schema (bukan data penuh) dan catat `_prisma_migrations`.
2. Terapkan migration di **staging** lebih dulu; verifikasi `migrate status` bersih.
3. Deploy kode yang **fail-closed** jika kolom belum ada (config reader menangkap `P2022`).
4. Baru deploy ke production; migration sebelum kode (karena PUT menulis kolom baru).
5. Rollback: `ALTER TABLE ... DROP COLUMN metaPixelEnabled, DROP COLUMN metaPixelId;` — hanya kehilangan konfigurasi Meta.

**Level risiko:** HIGH jika nama tabel tidak diverifikasi; LOW setelah preflight.

---

## 7. C7 — Pemisahan Status

Tiga gate yang berbeda dan tidak boleh digabung:

| Gate | Definisi | Bukti yang diperlukan | Status saat ini |
|---|---|---|---|
| **Ready for implementation** | Rencana, keputusan consent, CSP, migration preflight, dedup guard, dan PUT strategy disetujui | Dokumen ini disetujui + AC §11.1 | **NOT YET** (menunggu approval) |
| **Ready for staging verification** | Kode diimplementasikan; migration diterapkan di staging; unit/source-scan tests lulus; CSP staging aktif | Build/typecheck/lint, test suite, migration status, staging deployment | **NOT STARTED** |
| **Ready for production activation** | Staging evidence diterima; migration production diterapkan; `metaPixelEnabled=false`; rollback siap; consent mode diputuskan | Sign-off staging + checklist produksi | **BLOCKED** |

**Arti untuk Meta Purchase:**
- Implementasi boleh dimulai setelah gate 1.
- Meta Purchase **belum boleh diaktifkan** di staging sampai C1 selesai dan T1–T10 lulus.
- Production activation hanya setelah gate 3, dan flag tetap `false` sampai checklist aktivasi ditandatangani.

---

## 8. C8 — Batas Klaim Browser-Only MVP

| Klaim | Status | Penjelasan |
|---|---|---|
| Dedup lintas browser ↔ server | **TIDAK ADA** | Tidak ada Meta CAPI pada MVP. `eventID` hanya menyiapkan pasangan jika CAPI ditambahkan nanti. |
| Dedup browser-only | **TIDAK DIJAMIN** | Meta menyatakan browser-only tidak dideduplikasi; guard `sessionStorage` hanya best-effort per tab. |
| Jaminan event terkirim | **TIDAK ADA** | Adblock, ITP, CSP, kegagalan jaringan, consent denied → event hilang tanpa retry. |
| Purchase = revenue authoritative | **TIDAK** | Yang terukur adalah “browser-observed Purchase”, bukan pembayaran tervalidasi server. Nilai diambil dari DB, tetapi pengiriman tidak dijamin. |
| Exactly-once lintas tab/perangkat | **TIDAK ADA** | Perlu server-side claim + schema/endpoint (di luar MVP). |
| Server-side Meta events | **TIDAK ADA** | Tidak ada token/CAPI; tidak ada event jika browser gagal. |
| Retry/queue | **TIDAK ADA** | Tidak ada antrean atau pengiriman ulang. |

Jika advertiser membutuhkan konversi yang tahan adblock atau rekonsiliasi lintas perangkat, **CAPI adalah pekerjaan terpisah** dengan desain dedup, token server-only, dan pengujian tersendiri.

---

## 9. Dampak terhadap Arsitektur yang Diusulkan

Perubahan dari laporan awal:

1. **Consent layer baru** menjadi bagian dari `AnalyticsProvider` dan event helpers — bukan hanya Meta.
2. **Purchase claim module** baru (`lib/analytics/purchase-claim.ts`) dipakai TikTok dan Meta.
3. **`payment-finish` fix** menjadi mandatory, bukan opsional.
4. **Settings API** memerlukan versioning + presence semantics.
5. **Meta ID validator** berubah dari `15–16 digit` menjadi digit-only dengan batas longgar + warning.
6. **Migration** memerlukan preflight nama tabel.
7. **Status** dipecah menjadi tiga gate.
8. **Klaim dedup/delivery** dibatasi secara eksplisit.

Yang **tidak berubah**:

- Meta tetap ID-only; tidak ada JavaScript mentah dari admin.
- Tidak ada CAPI pada fase awal.
- Tidak ada perubahan checkout/payment gateway (kecuali jika S2 consent server-side dipilih, yang memerlukan approval terpisah).
- TikTok base code, payload, dan konfigurasi existing tidak diubah pada mode `legacy`.

---

## 10. File Plan Tambahan (di luar laporan awal)

### File baru

| File | Tujuan |
|---|---|
| `lib/analytics/purchase-claim.ts` | Claim per order+channel+pixel; in-memory + sessionStorage; testable |
| `lib/consent/state.ts` | Parse/normalize consent; pure functions |
| `lib/consent/read-server.ts` | (Opsional) baca cookie di server |
| `components/consent/ConsentProvider.tsx` | Context consent |
| `components/consent/ConsentBanner.tsx` | Banner Setujui/Tolak + link privasi |
| `components/analytics/TrackingGate.tsx` | Gate sebelum merender script |
| `__tests__/security/purchase-dedup.test.ts` | T1–T10 |
| `__tests__/security/consent-gating.test.ts` | Consent matrix |
| `__tests__/security/meta-pixel-id.test.ts` | Validasi ID |
| `__tests__/security/settings-concurrency.test.ts` | Stale form/409/presence |
| `docs/PRIVACY-POLICY-DRAFT.md` | Draf kebijakan privasi (konten legal perlu review) |

### File yang berubah (tambahan dari laporan awal)

| File | Perubahan |
|---|---|
| `app/checkout/payment-finish/payment-finish-content.tsx` | **Wajib**: stop polling final + ref/claim guard |
| `app/checkout/payment/[id]/page.tsx` | Gunakan claim lintas mount |
| `components/analytics/PurchaseTracker.tsx` | Gunakan claim; kirim Meta Purchase + `eventID` |
| `app/api/admin/settings/route.ts` | Presence semantics + `settingsVersion`/409 |
| `app/admin/settings/AdminSettingsForm.tsx` | Version handling, disable save saat load gagal, Meta section |
| `app/api/admin/settings/route.ts` + `lib/admin/audit-log.ts` | Audit `META_PIXEL_UPDATED` |
| `next.config.ts` | CSP Meta |
| `app/layout.tsx` / `AnalyticsProvider.tsx` | Gate consent |

---

## 11. Acceptance Criteria

### 11.1 Sebelum implementasi (wajib)

| ID | Kriteria | Bukti |
|---|---|---|
| AC-01 | Dokumen review ini disetujui sebagai dasar implementasi | Approval tertulis |
| AC-02 | Opsi consent dipilih: **A (server gate)** atau **B (client gate)**; mode awal TikTok ditetapkan (`legacy`) | Keputusan tertulis |
| AC-03 | Perubahan CSP disetujui (origin Meta eksplisit, tanpa wildcard) | Diff `next.config.ts` direview |
| AC-04 | Preflight staging: nama tabel fisik, `lower_case_table_names`, versi MySQL, `migrate status` | Output query + status |
| AC-05 | Strategi PUT disetujui: presence semantics + version/409; keputusan split endpoint | Desain disetujui |
| AC-06 | Strategi dedup disetujui: claim `sessionStorage` + batasan tab/perangkat; keputusan perlu server claim atau tidak | Desain + test matrix |
| AC-07 | Perbaikan `payment-finish` disetujui sebagai prerequisite (termasuk perubahan frekuensi event TikTok di route itu) | Approval |
| AC-08 | Validator Meta ID disetujui: digit-only 1–32, simpan string, warning 15–16 | Spesifikasi |
| AC-09 | Scope ditegaskan: browser-only, tanpa CAPI, tanpa dedup lintas channel, tanpa jaminan delivery | Risk acceptance |
| AC-10 | Keputusan gap consent server-side TikTok (S1/S2/S3) | Keputusan tertulis |

### 11.2 Sebelum staging verification

- [ ] Migration diterapkan di staging; `prisma migrate status` bersih; tidak ada drift.
- [ ] `payment-finish`: 10 tick setelah PAID → 1 event; tidak ada polling setelah final.
- [ ] T1–T10 lulus.
- [ ] Consent matrix lulus; mode `legacy` tidak mengubah TikTok (source-scan + runtime).
- [ ] CSP: Meta berfungsi; tidak ada origin wildcard; test `m4-csp` diperbarui.
- [ ] Admin: presence semantics, 409 stale form, explicit clear, audit log.
- [ ] Build, typecheck, lint, dan seluruh suite TikTok existing lulus.
- [ ] Meta Pixel Helper di staging test dataset: PageView 1×, ViewContent/AddToCart/InitiateCheckout/Purchase sesuai; **tidak ada event production**.

### 11.3 Sebelum production activation

- [ ] Migration production berhasil; backup + rollback SQL siap.
- [ ] `metaPixelEnabled` masih `false` setelah deploy; aktivasi terpisah.
- [ ] Consent mode dan banner aktif; kebijakan privasi tersedia dan tertaut.
- [ ] Monitoring 24 jam: tidak ada lonjakan Purchase, tidak ada duplicate berulang.
- [ ] Rollback: set flag `false`; jika perlu, revert CSP.
- [ ] Sign-off pemilik toko + (jika ada) review legal.

---

## 12. Keputusan Akhir

**CONDITIONAL GO untuk implementasi**, dengan syarat:

1. AC-01 s/d AC-10 disetujui.
2. C1 (payment-finish) dijadwalkan sebagai pekerjaan pertama dan **tidak boleh dilewati** sebelum Meta Purchase diaktifkan.
3. C2 memakai guard eksplisit; `eventID` tidak diklaim sebagai dedup browser.
4. C3 memakai mode `legacy` untuk TikTok sampai ada approval perubahan.
5. C5 dan C6 diselesaikan sebelum staging.
6. C7 gate dihormati: implementasi ≠ staging ≠ production activation.
7. C8 batasan browser-only diterima secara tertulis.

**Production activation tetap BLOCKED** sampai staging verification dan checklist §11.3 selesai. Dokumen ini bukan approval implementasi; approval harus diberikan eksplisit oleh pemilik produk.

---

## Lampiran A — Referensi Eksternal

| Topik | Sumber |
|---|---|
| Meta Pixel base code & ID | <https://developers.facebook.com/documentation/meta-pixel/get-started/> |
| Graph API Ad Pixel (`id` = numeric string) | <https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ads-pixel/> |
| Dedup Pixel/CAPI (browser-only tidak dideduplikasi) | <https://developers.facebook.com/documentation/ads-commerce/conversions-api/deduplicate-pixel-and-server-events> |
| Next.js `cookies()` & dynamic rendering | `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md` |

## Lampiran B — Referensi Kode Kunci

| Topik | Referensi |
|---|---|
| Schema datasource MySQL | `prisma/schema.prisma:6-9` |
| `StoreSetting` & `@@map` | `prisma/schema.prisma:605-657` |
| `updatedAt` StoreSetting | `prisma/schema.prisma:638` |
| Baseline tabel PascalCase | `prisma/migrations/0_baseline/migration.sql:219` |
| Migration lowercase | `prisma/migrations/20260922020000_add_tiktok_pixel_enabled/migration.sql:11` |
| Migration lock | `prisma/migrations/migration_lock.toml:3` |
| Settings select/projection | `app/api/admin/settings/route.ts:44-170` |
| Full-form write (update) | `app/api/admin/settings/route.ts:846-940` |
| `tiktokPixelEnabled` dari body | `app/api/admin/settings/route.ts:552` |
| Form mengirim seluruh state | `app/admin/settings/AdminSettingsForm.tsx:1729` |
| Form load | `app/admin/settings/AdminSettingsForm.tsx:531-615` |
| payment-finish polling | `app/checkout/payment-finish/payment-finish-content.tsx:39-137` |
| payment-finish Purchase effect | `app/checkout/payment-finish/payment-finish-content.tsx:175-201` |
| payment/[id] ref guard | `app/checkout/payment/[id]/page.tsx:73,187-215` |
| success page purchase gate | `app/checkout/success/page.tsx:170-215` |
| PurchaseTracker | `components/analytics/PurchaseTracker.tsx:120-136` |
| TikTok track guard | `lib/analytics/tiktok.ts:394-430` |
| Cookie reader | `lib/analytics/attribution.ts:144-169` |
| AnalyticsProvider | `components/analytics/AnalyticsProvider.tsx:31-60` |
| Root layout mount | `app/layout.tsx:113` |
| Webhook server event (tanpa consent) | `app/api/payment/midtrans/notification/route.ts:512`; `app/api/payment/ipaymu/notification/route.ts:581` |
