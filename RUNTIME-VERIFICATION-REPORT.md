# iPaymu Direct Payment Runtime Verification

**Date:** 2026-09-18 (re-run after the environment was reverted to sandbox)
**Scope:** runtime verification of the iPaymu Redirect → Direct Payment migration.
**Rule honored:** no production payment was attempted; `https://my.ipaymu.com` was never contacted. `# FINAL VERDICT` is at the bottom.

---

## 1. Environment safety (re-verified from scratch)

| Item | Value |
| --- | --- |
| `PAYMENT_ENVIRONMENT` | **`sandbox`** (`.env` line 32) |
| Provider endpoint resolved by the app | **`https://sandbox.ipaymu.com`** |
| Sandbox gate | `npx tsx scripts/verify-ipaymu-direct-runtime.ts check` → **`SANDBOX GATE: PASS`** |
| Sandbox credentials | present (`VA=<set,len=16,masked>`, `API_KEY=<set,len=43,masked>`) |
| Outbound provider URLs observed | `https://sandbox.ipaymu.com/api/v2/payment/direct` — **the only host used** |
| Occurrences of `my.ipaymu.com` in any provider call | **0** |
| Database | local `mysql://…@127.0.0.1:3306/toko` (MariaDB 11.8.8). The remote URL in `.env` is **commented out**; both `dotenv` and `@next/env` resolve to local |
| Production contacted | **NO** |

### 1.1 Why production cannot be reached from this flow
- `lib/payment/config.ts` selects credentials per `PAYMENT_ENVIRONMENT` with **no fallback and no default**; `sandbox` reads only `IPAYMU_SANDBOX_*`.
- The base URL must match a per-environment allowlist (`sandbox` → `https://sandbox.ipaymu.com`), and the resolved config is frozen.
- Both verification harnesses **refuse to start** unless the resolved config is the sandbox (this guard is what caught the production `.env` in the previous session).
- The legacy `IPAYMU_IS_PRODUCTION=true` / `IPAYMU_URL` / `IPAYMU_API_KEY` / `IPAYMU_VA` variables are still set but are read **only** by the non-operational legacy paths (`IPAYMU_CONFIG` in `lib/payment/ipaymu.ts`) — verified: every operational caller throws instead of using it (`4.1`–`4.4` exercised the real path).

### 1.2 Methodology correction worth knowing
`.env` in this repo is **indented by 4 spaces**, so anchored greps (`^KEY=`) silently miss keys. An early check in this session concluded `RAJAONGKIR_API_KEY` was unset on that basis; it is in fact **set**, and the live RajaOngkir rate call succeeds (see `8.5`). All conclusions below were re-derived with indent-tolerant checks and, where possible, by observing actual runtime behaviour instead of grepping config.

### 1.3 Safety notes
- No API key, secret, signature or merchant VA was printed. Provider values are reported as presence/length/host only.
- **Disclosure:** one inspection command (`head -3 .env | cat -A`) echoed cleartext database credentials into the transcript. It was not repeated; the workflow was changed to key-name/indent-tolerant checks afterwards.
- `scripts/test-ipaymu-payload.js` was **not executed**: it reads the legacy `IPAYMU_URL` (currently `https://my.ipaymu.com`) with **no sandbox guard**, so running it would send a production request. See finding **F1**.

---

## 2. Provider probes — actual sandbox responses

Run via the app's own `createDirectPayment()` (`scripts/verify-ipaymu-direct-runtime.ts probe`).

### 2.1 QRIS — `qris` vs `mpm` ambiguity (item 9)

The configured channel was probed **first**, then the documented alternative. **Both are accepted**, so no guess is needed:

| Channel | Status | `Via` | `Channel` echoed | QR delivered as | `Url` |
| --- | --- | --- | --- | --- | --- |
| `qris` (configured default) | 200 | QRIS | `QRIS` | `QrImage` (url host `sandbox.ipaymu.com`, len 64) | **absent** |
| `mpm` | 200 | QRIS | `MPM` | `QrImage` (same shape) | **absent** |

- The QR is returned in **`QrImage`**, never in `Url` — `buildPaymentInstruction()` already prefers `QrImage`, and the app mapped it correctly both times (`instructionQrImage` = url on `sandbox.ipaymu.com`).
- Extra response fields not in the documented contract were present and are unused: `Escrow`, `FeeDirection`, `NMID`, `NNSCode`, `SubTotal`, `Terminal`. The code reads only documented fields, so this is harmless — **documentation mismatch** (F6).
- `PaymentNo` for QRIS is the sandbox placeholder banner (`IPAYMU-SANDBOX-DEMO … THIS IS NOT A REAL QRIS / DO NOT SCAN / DO NOT PAY`), which independently confirms no real payment instrument was created.
- Provider expiry returned `2026-09-19 12:50` (~24 h) although the docs state a 5-minute QRIS window → **documentation mismatch** (F6). Because the app sends no `expired` field it uses the provider value, which is the intended behaviour.

### 2.2 Virtual Account (12 documented banks, reproducible over two runs)

| Bank | Result | Provider message |
| --- | --- | --- |
| bag, bca, bpd_bali, bni, cimb, mandiri, bmi, permata, btn | **200 OK** | `Success` |
| **bri** | **406** | `Failed to generate VA` |
| **danamon** | **406** | `Failed to generate VA` |
| **bsi** | **503** | `Service unavailable` |

- 9/12 succeeded; failures were byte-identical across two separate runs.
- The requests are identical in shape to the 9 that succeeded → the defect is provider-side, **not** an application bug. Classified **provider behaviour** (F4).
- Provider default expiry also varies per bank (most ~24 h, `bmi` 3 h) even though no `expired` was requested — again provider behaviour, not app logic.
- All 12 banks are in our server-side allowlist (`IPAYMU_VA_CHANNELS`), so a customer choosing BRI/BSI/Danamon currently gets a failed payment (fail-closed, rolled back — see `4.4`).

### 2.3 E-wallet

| Channel | Status | Provider message | App handling |
| --- | --- | --- | --- |
| **dana** | **200** | `Success` | `Url` present, host `m.sandbox.dana.id` → mapped to `paymentUrl`/`actionUrl` |
| **shopeepay** | **400** | `Payment failed. Failed from partner` | failed closed, **no instruction persisted** |
| ovo / gopay / linkaja | **400** | `Invalid payment channel` | failed closed, **no instruction persisted** |

- **DANA verified end-to-end** (the task's required channel).
- **ShopeePay is exposed in the UI** (`CheckoutPage.tsx:1595`, `BuyNowPage.tsx:168`) but the provider's partner leg rejects it → user-visible failure today. Classified **provider behaviour** (F3).
- `ovo`/`gopay`/`linkaja` are in our allowlist but **not** in the UI, and the provider reports them as invalid channels → **configuration/documentation drift**, dormant and unreachable from the UI (F5).

---

## 3. End-to-end flow verification

Driver: `scripts/verify-ipaymu-flow-runtime.ts` — real app over HTTP, real local database, real sandbox provider, signed webhooks, headless-Chrome render checks. Fixtures are restored on exit.

**Result: `PASS 47 | FAIL 0 | BLOCKED 0`** (production build, `next start`).

| # | Check | Result |
| --- | --- | --- |
| 1.1 | sandbox gate | PASS — `sandbox` / `https://sandbox.ipaymu.com` |
| 2.1–2.5 | app reachable; payment page, polling, expire and webhook all reject unauthenticated callers | PASS (302 / 401 / 401 / 401) |
| 3.1 | credentials sign-in | PASS — session cookie issued |
| 4.1 | QRIS instruction mapped | PASS — `qrImageUrl` host `sandbox.ipaymu.com` |
| 4.2 | VA instruction mapped | PASS — `paymentNo` set (len 16), channel BCA |
| 4.3 | e-wallet (dana) action mapped | PASS — host `m.sandbox.dana.id` |
| 4.4 | provider-rejected channel fails closed | PASS — no instruction persisted |
| 5.1–5.5 | payment page SSR shell, no credential leak, polling returns instruction, polling leaks no credential, owner-scoped | PASS |
| **5.6** | **QRIS page renders in a real browser** | PASS — title + order number + live status |
| **5.7** | **QR image element present in the DOM** | PASS — `<img>` src host `sandbox.ipaymu.com` |
| **5.8** | **VA page renders in a real browser** | PASS — VA label + number rendered (label BCA) |
| **5.9** | **e-wallet page renders in a real browser** | PASS — action link host `m.sandbox.dana.id` |
| 5.10 | rendered DOM leaks no credential | PASS |
| **5.11** | **polling flips the page to PAID** | PASS — signed webhook → browser re-rendered as *Pembayaran Berhasil* with no reload |
| 6.1 | invalid signature | PASS — 401 |
| 6.2 | wrong/unknown reference | PASS — 200 no-op, no state change |
| 6.3 | wrong amount | PASS — 400, order unchanged |
| 6.4 | **success webhook settles order** | PASS — 200 → `PAID` + `paidAt` |
| 6.5 | **duplicate webhook** | PASS — 200, `paidAt` unchanged (idempotent) |
| 6.6 | **cancelled-order resurrection** | PASS — stayed `CANCELLED`/`FAILED`, `paidAt` null |
| 6.7 | expiry notification cancels order | PASS — 200 → `CANCELLED`/`FAILED` |
| 6.8 | **stock release** | PASS — variant `967 → 970` (+3) |
| 6.9 | `product.sold` restored | PASS — `61 → 58` (−3) |
| 6.10 | **voucher release** | PASS — `usedCount 1 → 0`, per-user usage → 0 |
| 6.11 | **shipping-discount release** | PASS — `usedCount 1 → 0` |
| 7.1 | **expiry settlement** cancels + releases | PASS — `970 → reserved 968 → released 970` |
| 7.2 | open window not settled prematurely | PASS — `NOT_EXPIRED`, still `PENDING` |
| 7.3 | paid order not cancellable by expiry | PASS — `NOT_CANCELLABLE` |
| 7.4 | expiry is ownership-scoped | PASS — `NOT_FOUND` for another user |
| 8.1 | **repay** (authenticated) | PASS — 200, "Pembayaran ulang berhasil dibuat." |
| 8.2–8.4 | **cart regression** — add + read, quantity update, remove | PASS (201 / 200 / 200) |
| 8.5 | live shipping rates | PASS — 200, real option `jne/CTC` |
| 8.7 | COD route rejects non-COD | PASS — 400 |
| 8.8 | **COD order created end-to-end** | PASS — 201, `paymentStatus=UNPAID`, **no provider instruction fields** (COD never touches iPaymu) |
| 8.9 | client-sent shipping cost is ignored | PASS — client sent `1`, server persisted the live-verified `3000` |
| 8.10 | **Buy Now (iPaymu) end-to-end** | PASS — 201, real sandbox instruction returned, order payable on our own page |

### 3.1 Payment page specifics
- `/checkout/payment/[id]` is a **client component**: its server HTML is only a loading shell and the instruction is rendered in the browser from `/api/orders/{id}/payment-status`. Asserting the order number in the SSR HTML is therefore wrong (an earlier run produced exactly that false failure).
- Real-browser assertions were made with **headless Chrome driven over CDP** (Node built-ins only, no new dependency), seeding the real NextAuth session cookie.
- **Important:** under `next dev` (Turbopack) the page's client component did not complete hydration in this environment, so the DOM stayed on the loading shell even though the browser was correctly authenticated. The same page hydrates and renders correctly under a **production build** (`next build` + `next start`), where all browser checks pass. This is a **dev-server artifact, not an application defect** (F2) — reproduced deterministically and isolated with a standalone CDP probe.
- Confirmed live: no redirect to iPaymu, the browser only calls our own `/api/orders/{id}/payment-status`, and the merchant VA/API key never appear in HTML, JSON or the rendered DOM.

---

## 4. Tests / static checks

| Check | Result |
| --- | --- |
| `npx jest __tests__/ipaymu` | **157 passed / 157**; 1 suite reports "failed to run" (**pre-existing**, F7) |
| `npx tsx __tests__/ipaymu/production-hardening.test.ts` | **105 passed, 0 failed** |
| `npx tsc --noEmit` | **clean (exit 0)** |
| `npm run build` | **success** |
| CSP `img-src` allowlist | contains both `https://sandbox.ipaymu.com` and `https://my.ipaymu.com` — the live QR host (`sandbox.ipaymu.com`) is allowed |

---

## 5. Findings

### F1 — HIGH (pre-existing) — diagnostic script can reach production
`scripts/test-ipaymu-payload.js` reads `IPAYMU_URL` / `IPAYMU_API_KEY` / `IPAYMU_VA` and posts to `${baseUrl}/api/v2/payment/` with **no sandbox guard**. `IPAYMU_URL` currently resolves to `https://my.ipaymu.com`. **Not executed.** Classification: configuration + pre-existing code hazard. Minimal fix available (copy the sandbox guard already present in `scripts/test-ipaymu-sandbox.js`); recommend guarding or deleting.

### F2 — MEDIUM — client-rendered payment page does not hydrate under `next dev`
Under Turbopack dev the payment page stayed on its loading shell; the same page works in a production build. Classification: **development-server behaviour**, not an application bug (the production build is what ships). Recommendation: verify UI changes against a production build.

### F3 — MEDIUM (user-visible) — ShopeePay is offered but rejected by the provider
`shopeepay` is in the UI, but the sandbox provider returns `400 Payment failed. Failed from partner`. Classification: **provider behaviour**. The app fails closed and rolls back. Action: confirm with iPaymu whether ShopeePay is enabled for this merchant; if not, hide the option (product decision, not made here).

### F4 — MEDIUM — allowlisted VA banks that the provider cannot serve
`bri` (406 `Failed to generate VA`), `danamon` (406), `bsi` (503 `Service unavailable`) are in `IPAYMU_VA_CHANNELS` and fail reproducibly. Classification: **provider behaviour**. No code change made (evidence does not show an application defect). Recommendation: track provider availability; consider failing over or hiding unusable banks.

### F5 — LOW — server allowlist is wider than the supported set
`IPAYMU_EWALLET_CHANNELS` includes `ovo`, `gopay`, `linkaja`, which the provider answers with `400 Invalid payment channel`. They are **not** exposed in the UI, so impact is latent (a crafted API request fails closed with no stuck order). Classification: **configuration/documentation drift**.

### F6 — LOW — provider response/expiry documentation drift
Undocumented response fields (`Escrow`, `FeeDirection`, `NMID`, `NNSCode`, `SubTotal`, `Terminal`) and per-channel default expiries that contradict the docs (QRIS ~24 h vs documented 5 min; VA ~24 h except `bmi` 3 h). Classification: **documentation mismatch**. The app ignores undocumented fields and always uses the provider's returned `Expired`.

### F7 — LOW (pre-existing) — `production-hardening.test.ts` cannot run under Jest
It defines its own runner for `tsx` but matches Jest's `testMatch`, so Jest reports the suite as failed while its real result via `tsx` is 105/105. Unchanged from before; out of scope.

### F8 — LOW — stale fixtures from an earlier session
Local DB contains residue from run `VRMU6I2CVH` (2026-09-18T05:10Z, a previous session): 1 user, 1 address, 1 voucher, 10 `VERIFY-*` orders. All runs **in this session** cleaned up correctly (order count and variant stock returned exactly to their starting values: orders `159`, variant 10 stock `978`). Not deleted — flagging rather than modifying data.

### F9 — INFO — the previous session's blocker is resolved
The earlier BLOCKED state was caused by `.env` resolving to `production`. It now resolves to `sandbox`, `IPAYMU_SANDBOX_*` are the selected credentials, and the fail-closed production guard was never triggered.

---

## 6. Code changes

**No application code was changed** — no runtime defect attributable to the application was demonstrated.

Only the verification harness `scripts/verify-ipaymu-flow-runtime.ts` was changed, and every change was to fix a **harness** defect (each initially produced a false failure):

| Harness fix | Why |
| --- | --- |
| 5.1: assert the client shell instead of the order number in SSR HTML | the page is a client component; the old assertion could never pass |
| 5.6–5.11: real headless-Chrome render checks (CDP) | the payment page is only meaningful when rendered in a browser |
| 5.8: case-insensitive label match | Chrome applies `text-transform: uppercase` to `innerText` |
| 7.1: measure the stock baseline immediately before the order's reservation | the pre-run snapshot is wrong while other fixture orders hold reservations |
| 8.5: derive courier/service/cost from the live rate response | a hard-coded `jne REG` is not necessarily served for this route |
| 8.6: reseed the cart before checkout | the cart-deletion test had emptied it (`Keranjang kosong`) |
| 8.9: send a deliberately false client cost | comparing to a 1000 g quote is unsound — the server prices the variant's real weight |
| 8.8/8.10: assert COD/Buy Now persisted state | proves COD carries no provider data and Buy Now yields a real instruction |

---

## FINAL VERDICT

**SANDBOX VERIFIED — PASS (sandbox-verified only, NOT production-ready)**

`47/47` flow checks pass against the **real iPaymu sandbox** with the real local database and real signed webhooks, including every phase the previous session had to leave BLOCKED: QRIS, VA, DANA, the payment page and its polling, success/duplicate/invalid-signature/wrong-amount/wrong-reference/cancelled-resurrection webhooks, expiry settlement, stock/voucher/shipping-discount release, repay, Buy Now and COD. QRIS `qris` vs `mpm` was resolved by testing the configured channel first — **both work**, so no guess was needed. `PAYMENT_ENVIRONMENT=sandbox`, the resolved endpoint is `https://sandbox.ipaymu.com`, and **production was never contacted**.

This verdict is **not** a production-readiness statement. Open items before any production cut-over:

1. **F3** ShopeePay is offered in the UI but rejected by the provider (partner-side) — confirm availability or hide it.
2. **F4** BRI / BSI / Danamon VAs fail provider-side despite being allowlisted.
3. **F1** `scripts/test-ipaymu-payload.js` has no sandbox guard and currently points at production — guard or delete it.
4. **F5** narrow the e-wallet allowlist to what the provider accepts.
5. A real-money production verification must remain a separate, explicitly authorized step.
