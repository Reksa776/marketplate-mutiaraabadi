# PHASE 1 — PURCHASE TRACKING HARDENING (C1 + C2)

Status: **C1 + C2 selesai, terverifikasi lokal.**
Meta Purchase **belum aktif**. Script Meta Pixel **tidak dipasang**. Consent system (C3) **tidak diimplementasikan**.

Referensi:
- `docs/META-PIXEL-INTEGRATION-AUDIT.md` (audit awal, tidak diubah)
- `docs/META-PIXEL-PREIMPLEMENTATION-REVIEW.md` (review pra-implementasi, tidak diubah)

---

## 1. Baseline dan working tree

Baseline commit: `main` (117 commit). Sebelum perubahan, working tree sudah memiliki pekerjaan pre-existing yang **tidak disentuh**:

| Status | Path | Keterangan |
|---|---|---|
| M | `app/api/payment/ipaymu/notification/route.ts` | pre-existing |
| M | `app/api/payment/midtrans/notification/route.ts` | pre-existing |
| M | `lib/admin/audit-log.ts` | pre-existing |
| ?? | `lib/payment/webhook-trace.ts` | pre-existing |
| ?? | `__tests__/security/payment-webhook-orphan-trace.test.ts` | pre-existing |
| ?? | `docs/order-cleanup/`, `scripts/order-cleanup/` | pre-existing |
| ?? | `docs/META-PIXEL-INTEGRATION-AUDIT.md`, `docs/META-PIXEL-PREIMPLEMENTATION-REVIEW.md` | fase sebelumnya |

File yang diubah fase ini (tidak ada overlap dengan daftar di atas):

- `M app/checkout/payment-finish/payment-finish-content.tsx`
- `M app/checkout/success/page.tsx` (eligibility diekstrak ke helper murni — semantik identik)
- `M components/analytics/PurchaseTracker.tsx`
- `M components/analytics/TikTokPixel.tsx`
- `M lib/analytics/tiktok.ts`
- `M __tests__/security/tiktok-purchase-identity.test.ts` (hanya reset state claim antar test)
- `A lib/analytics/purchase-claim.ts`
- `A lib/analytics/purchase-eligibility.ts`
- `A lib/payment/payment-status-poll.ts`
- `A __tests__/security/purchase-claim-hardening.test.ts`
- `A docs/meta-pixel/PHASE-1-C1-C2-PURCHASE-HARDENING.md`

Tidak ada migration, schema Prisma, environment variable, CSP, webhook, business logic checkout, deployment, atau commit.

### Perbedaan implementasi aktual vs laporan audit

Ditemukan dan dikoreksi saat inspeksi:

1. Route konfirmasi ketiga (`/checkout/payment/[id]`) **sudah** punya per-mount ref guard dan sudah menghentikan polling saat final (`isFinal` di dependency). Jadi C1 hanya mengenai `payment-finish`.
2. `/checkout/success` memakai guard eligibility di server (PAID, atau COD yang belum refund/cancel). Aturannya **tidak diubah**, hanya dipindahkan ke `lib/analytics/purchase-eligibility.ts` agar bisa diuji langsung (dan agar "COD eligible" punya test eksplisit).
3. `lib/analytics/tiktok.ts` **sudah** mengirim Pixel ID ke browser sebagai `data-pixel-id` pada tag `<script id="tiktok-pixel-base">`. Tidak perlu API baru; claim membaca atribut itu.
4. File ini juga memperbaiki dua bug React yang sudah ada di `payment-finish-content.tsx` (lihat §3.3) karena keduanya berada di jalur yang sama.

---

## 2. Root cause C1

Kode lama `app/checkout/payment-finish/payment-finish-content.tsx`:

```ts
const interval = setInterval(() => {
    setAttempts((current) => {
        if (current >= maxAttempts) {
            clearInterval(interval);
            setLoading(false);
            return current;
        }

        poll();          // <-- efek samping di dalam state updater
        return current;
    });
}, 3000);
```

Empat cacat yang saling memperkuat:

1. **`poll()` dipanggil dari dalam state updater.** React boleh menjalankan updater lebih dari sekali untuk render yang sama; selain itu updater harus murni.
2. **Final status tidak menghentikan interval.** `poll()` hanya `return` setelah `setLoading(false)`; interval tetap hidup dan terus memanggil `setAttempts` → `poll()` setiap 3 detik.
3. **Objek order baru setiap poll.** `setOrder(result.data)` membuat objek baru, dan effect Purchase memakai `[isPaid, order]` sebagai dependency:

   ```ts
   useEffect(() => {
       if (!isPaid || !order) return;
       whenTikTokReadyForEvents(() => trackAuthoritativeTikTokPurchase({...}));
   }, [isPaid, order]);
   ```

   Setelah PAID, setiap response polling berikutnya mengganti `order` → effect jalan lagi → **CompletePayment terkirim ulang tiap ±3 detik** sampai user meninggalkan halaman.
4. **Tidak ada guard per-mount** dan tidak ada status "sudah berhenti"; komponen hanya menyimpulkan dari `loading`.

`event_id` deterministik (`ttq:completepayment:<orderNumber>`) **tidak** menolong di sini: dedup TikTok hanya berlaku antara Pixel (browser) dan Events API (server), bukan antara dua event browser.

---

## 3. Implementasi perbaikan polling

### 3.1 Modul baru `lib/payment/payment-status-poll.ts`

Loop polling dipindahkan ke modul murni yang bisa diuji:

```ts
const poller = createPaymentStatusPoller<OrderStatus>({
    fetchStatus,   // Promise<T | null>
    isFinal,       // (T) => boolean
    onStatus,      // setOrder
    onDone,        // setLoading(false)
    onError,       // console.error (observability)
    intervalMs: 3000,
    maxAttempts: 15,
});
poller.start();
return () => poller.stop();
```

Jaminan:

- **Maksimal satu request in-flight** (`inFlight` flag). Tick interval saat request masih berjalan tidak menghasilkan request kedua.
- **Berhenti pada status final pertama** (PAID / FAILED / EXPIRED) — interval dibersihkan, bukan sekadar diabaikan.
- **Berhenti setelah budget 15 request** (final termasuk), sama seperti `maxAttempts` lama.
- **`stop()` idempotent** dan selalu `clearInterval`. `start()` setelah `stop()` adalah no-op.
- **Timer dipasang sebelum request pertama**, sehingga settle sinkron tetap membersihkan timer.
- **Response terlambat diabaikan** setelah `stop()` (unmount) — tidak menyentuh state komponen.
- **Error jaringan tidak fatal**: dihitung sebagai attempt, dilaporkan via `onError`.
- Tidak ada keputusan status di browser: poller hanya meneruskan apa yang dikembalikan server.

### 3.2 Perubahan komponen `payment-finish-content.tsx`

- Menghapus `attempts` state dan `setInterval` lokal; polling sepenuhnya lewat poller.
- `/api/payment/status` respons non-2xx / `success:false` / body kosong dipetakan ke `null` (attempt saja, tanpa mengubah UI) — sama seperti perilaku lama.
- `onError` mempertahankan log `POLL PAYMENT STATUS ERROR:`.
- **Purchase tidak lagi dipicu objek `order`**: dependency effect sekarang `paidOrderNumber`, `paidTotal`, `paidIdentity` (primitif + objek digest dari server), dengan **ref guard per-mount** `purchaseTracked.current === paidOrderNumber`.
- Tampilan dan alur status (pending/loading, pending settle, PAID, FAILED/EXPIRED, tombol) tidak berubah.

### 3.3 Bug React yang ikut diperbaiki (jalur yang sama)

- `useEffect` Purchase berada **setelah** early return `if (!reference)` → melanggar *rules of hooks* dan bisa mengubah urutan hook saat `?payment=` berubah. Early return dirender dipindah ke **setelah** semua hook.
- `setLoading(false)` sinkron di body effect (cabang `!reference`) dihapus; layar "referensi tidak ditemukan" tidak membutuhkan state itu.

Keduanya ditemukan oleh `eslint` (react-hooks) setelah perubahan dan diperbaiki, bukan disuppress.

---

## 4. Desain Purchase claim

Modul: `lib/analytics/purchase-claim.ts`.

```
tracking:purchase:<channel>:<pixelId>:<orderNumber>
```

Contoh: `tracking:purchase:tiktok:C1A2B3C4D5E6F7G8H9J0:PAY-CART-900`

### API

| Fungsi | Kontrak |
|---|---|
| `buildPurchaseClaimKey(input)` | key atau `null` bila order/channel kosong |
| `hasPurchaseClaim(input, opts?)` | true bila sudah diklaim (memory atau storage) |
| `claimPurchase(input, opts?)` | true **hanya** untuk pemanggil yang menang; menulis claim sebelum event |
| `resetPurchaseClaimsForTests()` | reset Set in-memory |
| `buildMetaPurchaseEventId(order)` | `meta:purchase:<order>` — kontrak Meta, belum dipakai |

### Aturan yang diimplementasikan

- **Channel terpisah**: `tiktok` dan `meta` tidak pernah berbagi key.
- **Pixel ID bagian dari key**: rotasi pixel menghasilkan key baru, claim lama tidak memblokir (T10). Bila browser belum bisa resolve pixel id (mis. pixel aktif tapi ID kosong di settings), dipakai sentinel eksplisit `unknown` — bukan ID palsu — dan claim itu tidak pernah memblokir pixel id nyata yang muncul kemudian.
- **Order number bagian dari key** (bukan id database, bukan user id).
- **In-memory `Set` + `sessionStorage`**. Set menangani remount dan navigasi client-side; storage menangani reload tab yang sama.
- **Semua akses storage dibungkus try/catch** (termasuk akses `window.sessionStorage` itu sendiri — Safari private mode / cookie diblokir / webview). Bila storage gagal, guard tetap berjalan in-memory.
- **Claim hanya dibuat setelah**: eligibility (dipanggil hanya untuk order yang convertible), Pixel API tersedia (`window.ttq`), dan — nanti di C3 — consent gate. Claim ditulis **sebelum** `identify()` dan `track()`.
- **Tidak ada retry.** Claim berarti "sudah dicoba sekali", bukan "terkirim".
- **Tidak menyimpan PII / token**: nilai yang ditulis literal `"1"`; key hanya berisi channel, pixel id publik, dan nomor pesanan publik.

### Claim vs eligibility

Dua guard yang berbeda dan tidak saling menggantikan:

- **Eligibility** (`lib/analytics/purchase-eligibility.ts`): apakah order ini boleh menghasilkan Purchase sama sekali (PAID, atau COD yang belum refund/cancel). Dipakai `/checkout/success` sebelum tracker dirender; diekstrak dari halaman tanpa mengubah aturan.
- **Claim** (`lib/analytics/purchase-claim.ts`): apakah browser ini sudah pernah mengirim Purchase untuk channel + pixel + order tersebut.

### Integrasi (satu claim untuk tiga jalur)

Claim dipasang di **satu** entry point yang sudah dipakai ketiga route: `trackAuthoritativeTikTokPurchase()` di `components/analytics/PurchaseTracker.tsx`.

```
isTikTokPixelReady()  →  claimPurchase()  →  ttq.identify()  →  ttq.track()
```

- `payment/[id]`, `payment-finish`, dan `/checkout/success` tidak mendapat implementasi claim sendiri-sendiri.
- Pixel ID dibaca dari `data-pixel-id` pada `#tiktok-pixel-base` (`resolveTikTokBrowserPixelId()` di `lib/analytics/tiktok.ts`) — jalur config yang sudah ada, tanpa API baru, tanpa duplikasi setting, tanpa ID palsu.
- `TikTokPixel.tsx` sekarang memakai konstanta `TIKTOK_PIXEL_SCRIPT_ID` (nilai render identik) agar id script tidak bisa drift dari resolver.
- **Payload TikTok tidak berubah**: event name `CompletePayment`, `properties` (`value`, `currency`, `order_id`, `contents`), Advanced Matching, dan `event_id` `ttq:completepayment:<orderNumber>` tetap sama. Events API server tidak disentuh.

### Meta eventID

`buildMetaPurchaseEventId()` menghasilkan `meta:purchase:<orderNumber>` dan diuji stabil. **Tidak dipanggil dari mana pun** pada fase ini — hanya kontrak untuk fase Meta berikutnya. `eventID` secara eksplisit **bukan** mekanisme dedup browser-only (didokumentasikan di modul dan di review pra-implementasi).

---

## 5. File yang dibuat dan dimodifikasi

Dibuat:

| Path | Baris | Isi |
|---|---|---|
| `lib/analytics/purchase-claim.ts` | 296 | claim browser (key, memory+sessionStorage, Meta event id) |
| `lib/analytics/purchase-eligibility.ts` | 55 | aturan eligibility Purchase (PAID / COD) — diekstrak dari halaman success |
| `lib/payment/payment-status-poll.ts` | 184 | poller status pembayaran (single in-flight, stop on final) |
| `__tests__/security/purchase-claim-hardening.test.ts` | 1149 | 48 test C1 + C2 + eligibility |
| `docs/meta-pixel/PHASE-1-C1-C2-PURCHASE-HARDENING.md` | — | laporan ini |

Dimodifikasi:

| Path | Perubahan |
|---|---|
| `app/checkout/payment-finish/payment-finish-content.tsx` | polling via poller, per-mount guard, dependency Purchase bukan objek order, urutan hook |
| `app/checkout/success/page.tsx` | guard eligibility memanggil `isBrowserPurchaseEligible` (semantik sama persis) |
| `components/analytics/PurchaseTracker.tsx` | claim sebelum identify/track, early return saat Pixel tidak ada, `pixelId` opsional |
| `lib/analytics/tiktok.ts` | `TIKTOK_PIXEL_SCRIPT_ID`, `resolveTikTokBrowserPixelId()` |
| `components/analytics/TikTokPixel.tsx` | memakai konstanta id script (markup identik) |
| `__tests__/security/tiktok-purchase-identity.test.ts` | `resetPurchaseClaimsForTests()` di `beforeEach` (test lama memakai order number yang sama untuk menguji payload) |

Tidak diubah: `lib/analytics/tiktok-events-api.ts`, `lib/analytics/tiktok-events-config.ts`, webhook payment, `app/checkout/payment/[id]/page.tsx`, Prisma schema, CSP, env.

---

## 6. Test matrix T1–T10

Suite: `__tests__/security/purchase-claim-hardening.test.ts` — **48 test, semua lulus**.

| ID | Skenario | Ekspektasi | Status | Bukti |
|---|---|---|---|---|
| T1 | Reload halaman 3× | 1 Purchase | **LULUS** | `T1. three reloads...` (sessionStorage dipertahankan, state modul di-reset) |
| T2 | React remount | 1 Purchase | **LULUS** | `T2. a React remount...` |
| T3 | Navigasi tiga route Purchase | 1 Purchase total | **LULUS** | `T3. three confirmation routes...` (event_id tetap sama) |
| T4 | Dua order berbeda | 2 Purchase | **LULUS** | `T4. two different orders...` |
| T5 | Order sama di tab berbeda | Known limitation | **LULUS (terdokumentasi)** | `T5. another tab...` — 2 event, sesuai keterbatasan |
| T6 | Pixel API tidak tersedia | 0 event, 0 claim | **LULUS** | `T6.` — tidak ada claim, dan attempt tidak "terbakar" |
| T7 | Consent gate menolak tracking | 0 event | **PENDING C3** | Belum ada consent gate (tidak dibuat palsu). Test menegaskan modul claim tidak mengandung consent implisit |
| T8 | 10 tick polling setelah PAID | 1 Purchase, polling berhenti | **LULUS** | `T8.` — `onStatus` = `["PENDING","PAID"]`, fetch berhenti |
| T9 | Deterministic event ID | Stabil | **LULUS** | `T9.` — `meta:purchase:<order>` stabil; event id TikTok diverifikasi di T3 |
| T10 | Pixel ID berubah | Claim lama tidak memblokir pixel baru | **LULUS** | `T10.` — 2 event, event_id sama, claim berbeda |

Test tambahan (di luar matrix):

- **Eligibility (COD):** PAID eligible; PENDING/FAILED/EXPIRED/REFUNDED non-COD tidak; COD `UNPAID` yang masih live eligible; COD `REFUNDED` dan COD `CANCELLED` tidak; `paymentMethod` null/undefined tidak pernah eligible; Pending → Paid bertransisi menjadi eligible; halaman success tetap merender tracker hanya saat eligible.
- Pending → Paid (T8) dan FAILED / EXPIRED sebagai final (`test.each`).
- Status non-final (`CANCELLED` pada `paymentStatus`) tetap memakai budget 15 (perilaku lama dipertahankan).
- Unmount saat polling aktif: timer dibersihkan, response terlambat tidak menyentuh state.
- Concurrent polling response: hanya satu request in-flight; tick selama request berjalan tidak menambah request.
- Late response tidak bisa menimpa status (hanya satu request, satu apply).
- Budget habis karena respons unusable + error berselang-seling.
- `stop()` idempotent; `start()` setelah `stop()` no-op.
- `onError` menerima error jaringan.
- Storage tidak tersedia (semua akses throw) → tetap 1 claim.
- Nilai asing di storage (`"0"`) bukan claim.
- Claim dari load sebelumnya memblokir load baru.
- Key: format, pemisahan channel/pixel/order, sentinel `unknown`, key `null` untuk order kosong, hanya `"1"` yang disimpan.
- Tracker: Pixel tidak ada → 0 event 0 claim; klaim ganda → `identify` juga tidak diulang.
- Source guard: urutan `isTikTokPixelReady → claimPurchase → identify → track`; poller dipakai; `setInterval`/`setAttempts` hilang dari komponen; dependency purchase bukan `[isPaid, order]`; pixel id dibaca dari script yang dirender.

---

## 7. Hasil regression TikTok

Perintah dan hasil (exit status dipertahankan via `set -o pipefail`):

| Perintah | Hasil |
|---|---|
| `npx jest __tests__/security` | **82 suite lulus, 1832 test lulus, 4 skipped, 0 gagal** |
| `npx jest __tests__/security/purchase-claim-hardening.test.ts` | 48/48 lulus |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint <8 file terkait>` | exit 0 (0 error, 0 warning) |
| `npx next build` | exit 0 (semua route ter-build, termasuk `/checkout/payment-finish`) |

Tidak ada test TikTok yang dihapus, dilemahkan, atau di-skip. Satu-satunya perubahan pada test lama adalah `resetPurchaseClaimsForTests()` di `beforeEach` `tiktok-purchase-identity.test.ts`, karena suite itu sengaja mengirim beberapa Purchase dengan **order number yang sama** untuk memeriksa payload; dedup sendiri diuji di suite baru. Assertion payload/identity/event_id tidak berubah.

Events API server (`lib/analytics/tiktok-events-api.ts`) dan payload-nya: **tidak ada perubahan**, seluruh test terkait lulus.

---

## 8. Known limitations

1. **Lintas tab / browser / perangkat tidak dideduplikasi.** `sessionStorage` bersifat per tab. Order yang sama dibuka di dua tab dapat mengirim dua event browser (T5). Ini batas browser-only MVP dan **bukan** diklaim sebagai dedup penuh.
2. **Tidak ada dedup browser↔server.** `event_id` hanya untuk pasangan Pixel↔Events API; itu tidak mencegah dua event browser.
3. **Claim ≠ delivery.** Claim ditulis sebelum event; bila Pixel memblokir/membuang event, konversi hilang dan **tidak** dikirim ulang (tidak ada retry, sesuai desain).
4. **Reload dedup bergantung pada `sessionStorage`.** Bila storage diblokir, hanya remount/navigasi dalam satu load yang terlindungi.
5. **Consent gate belum ada (C3).** Saat ini claim tidak didahului pemeriksaan consent karena mekanisme consent belum diimplementasikan. T7 **pending** dan wajib diselesaikan sebelum Meta Purchase diaktifkan.
6. **Pixel ID di browser bergantung pada `data-pixel-id`.** Bila admin mengaktifkan pixel tanpa menyimpan ID, key memakai sentinel `unknown` (dedup tetap jalan per order/channel, tetapi tidak memisahkan pixel).
7. **Meta Purchase belum aktif.** Tidak ada script Meta, tidak ada call site Meta, `buildMetaPurchaseEventId` belum dipakai.
8. Pengukuran Purchase browser tetap bukan sumber revenue authoritative (Events API server tetap acuan).

---

## 9. Risiko yang tersisa

| Risiko | Dampak | Mitigasi saat ini |
|---|---|---|
| Claim dibuat lalu event gagal terkirim (adblock, jaringan) | 1 konversi hilang per order/pixel/tab | Diterima sebagai trade-off anti-duplikasi; tanpa retry sesuai spesifikasi |
| `sessionStorage` dibersihkan user / mode privat | Duplikat bisa muncul setelah reload | Dedup in-memory tetap jalan dalam satu load |
| Dua tab untuk order yang sama | 2 event browser | Didokumentasikan (T5); solusi butuh claim server-side (di luar MVP) |
| Rotasi Pixel ID saat halaman lama masih terbuka | Event bisa dikirim ke pixel lama | Key memisahkan pixel; rotasi tetap terdeteksi sebagai klaim baru (T10) |
| Consent belum di-enforce | Tracking tetap berjalan tanpa consent | **Blocker produksi**; C3 harus mendahului aktivasi Meta |
| Perubahan `payment-finish` menyentuh halaman pembayaran | Regresi UX/status | Perilaku status dipertahankan; 82 suite + build lulus; **belum diuji di browser nyata** |

Catatan verifikasi: seluruh pengujian bersifat unit/integration (Node + source guard). Belum ada verifikasi manual di browser (reload/remount sesungguhnya, Strict Mode dev, storage diblokir) maupun staging. Itu masuk tahap *Ready for staging verification*.

---

## 10. Readiness untuk fase berikutnya

| Gate | Status |
|---|---|
| Ready for implementation (C1 + C2) | **SELESAI** |
| Ready for staging verification | **BELUM** — perlu uji browser: reload, remount, navigasi 3 route, tab kedua, storage diblokir, Strict Mode |
| Ready for production activation (Meta Purchase) | **BLOCKED** — menunggu C3 (consent bersama) dan fase Meta Pixel |

Yang sudah menjadi fondasi untuk fase berikutnya:

- `claimPurchase()` siap dipakai channel `meta` (key terpisah, T10 sudah diuji).
- `buildMetaPurchaseEventId()` tersedia sebagai kontrak `meta:purchase:<order>`.
- Titik integrasi tunggal (`trackAuthoritativeTikTokPurchase`) adalah tempat yang tepat untuk menambahkan consent gate (C3) dan Meta event di fase lanjutan — **tidak** ditambahkan pada fase ini.

**Tidak ada pekerjaan C3 atau Meta Pixel yang dimulai.**
