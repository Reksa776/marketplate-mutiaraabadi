# iPaymu Redirect → Direct Payment Migration

**Status:** Phases 1–10 complete (audit + design + implementation + automated tests).
Phase 10 runtime payment verification is **outstanding** — no live iPaymu transaction was
performed, so this work must not be called production-ready yet. See
“IMPLEMENTATION (PHASES 3–11)” at the end for what was built and what still needs a
runtime check.

**Hard constraints honored throughout**

- Production credentials are NOT changed, and production is NOT switched to sandbox.
- Webhook signature validation is NOT weakened and NOT removed.
- An order is never marked PAID because of a browser redirect or client call —
  the webhook stays the single source of truth for settlement.
- No unrelated pricing / voucher / shipping / affiliate / auth code is touched.

---

## PHASE 1 — READ-ONLY AUDIT

### 1.1 `createRedirectPayment()` and the iPaymu API client

| Item | Location |
| --- | --- |
| Redirect payment creation | `lib/payment/ipaymu.ts` → `createRedirectPayment()` (POST `/api/v2/payment/`) |
| Signature generation | `lib/payment/ipaymu.ts` → `generateSignature()` (SHA256(body) → `POST:VA:hash:apiKey` → HMAC-SHA256(apiKey)) |
| Timestamp | `generateTimestamp()` → `YYYYMMDDHHmmss` |
| Amount/product validation | inside `createRedirectPayment()` (`Number.isFinite`, array length match) |
| Timeout + error taxonomy | `[TIMEOUT]`, `[DNS_ERROR]`, `[CONNECTION_REFUSED]`, `[CONNECTION_RESET]`, `[TLS_ERROR]`, `[NETWORK_ERROR]`, `[AUTH_ERROR]`, `[IPAYMU_SERVER_ERROR]`, `[IPAYMU_HTTP_ERROR]`, `[IPAYMU_API_ERROR]`, `[INVALID_JSON]` |
| Success requirement | `result.Status === 200` **and** `result.Data.Url` present (redirect-hosted page) |
| Config resolver (fail-closed) | `lib/payment/config.ts` → `getIpaymuConfig()` / `buildIpaymuConfig()` — `PAYMENT_ENVIRONMENT ∈ {sandbox, production}`, per-environment VA/API key, base-URL allowlist (no SSRF / no cross-env), production bans sandbox-VA reuse + localhost `NEXT_PUBLIC_APP_URL` |
| Production validator | `lib/payment/ipaymu-production.ts` → `validateIpaymuProductionConfig()`, `initIpaymuConfig()`, `getIpaymuConfigSummary()`, `validateCallbackUrl()` |
| Status verification (server→server) | `verifyPaymentStatus()`, `isPaymentConfirmed()` — unused by the current flow (webhook only) |

### 1.2 HTTP endpoints that exist today

| Endpoint | Role |
| --- | --- |
| `POST /api/payment/ipaymu` | Cart checkout → `createCheckoutOrder()` → `createRedirectPayment()` → returns `paymentUrl` (iPaymu hosted page) |
| `POST /api/buy-now/ipaymu` | Buy-now checkout → same redirect flow |
| `POST /api/orders/[id]/repay` | Repay: CAS reset to `PENDING` + re-reserve stock → new redirect payment → returns `redirectUrl` |
| `POST /api/payment/ipaymu/notification` | Webhook (authoritative settlement) |
| `GET /api/payment/status?reference=` | Order-status poll used by `/checkout/payment-finish` |
| `POST /api/orders/[id]/cancel` | Customer cancels own unpaid order (CAS + full release) |
| `POST /api/orders` | COD order (unchanged, out of scope) |

### 1.3 Webhook endpoint (current behavior — preserved)

`app/api/payment/ipaymu/notification/route.ts`

1. Reads the **raw** body first (`request.text()`), never `request.json()`.
2. Requires headers `X-Signature`, `X-Timestamp`, `X-External-ID` → 401 if missing.
3. Resolves VA via `getIpaymuConfig()` → `verifyWebhookSignature(rawBody, sig, va)`
   (form decode → type normalize → PHP `ksort` → `JSON.stringify` → escape `/` →
   `HMAC-SHA256(VA, canonicalJson)` → `timingSafeEqual`) → 401 on failure.
4. Normalizes snake_case → PascalCase (`reference_id`, `sid`, `trx_id`, `amount`, `status_code`, `via`, `channel`, `status`).
5. Finds order by `reference_id` (fallback `sid`); unknown order → 200 (no provider retry storm).
6. Amount check `verifyNotificationAmount()` prefers `sub_total` (excludes iPaymu fee) → 400 on mismatch.
7. `classifyIpaymuNotification()` → `success | pending | failed | unknown` (unknown = acknowledged, never mutates).
8. **Success** → atomic CAS `UPDATE order SET status='PAID', paymentStatus='PAID', paidAt=IFNULL(...), paymentReference=COALESCE(...) WHERE status IN ('PENDING','PROCESSING') AND paymentStatus NOT IN ('PAID','REFUNDED')`; on transition clears only the ordered cart items for `PAY-CART-*`; fires `onOrderStatusChanged`.
9. **Pending** → CAS `status='PENDING', paymentStatus='PENDING'` guarded by `paymentStatus != 'PAID'`.
10. **Failed/expired** → CAS `status='CANCELLED', paymentStatus='FAILED'` + `releaseStockAndVoucherForOrder()` + `cancelCommissionForOrder(..., "ORDER_PAYMENT_FAILED")`.
11. **Refund** → `transitionRefundForWebhook()` + `executeRefundCompletion()`.
12. Unexpected errors → HTTP 500 so iPaymu retries.

### 1.4 Payment status mapping (current)

| Provider signal | Classification | Effect |
| --- | --- | --- |
| `Status === 200`, `status === "berhasil"`, `status_code === 1` | success | order PAID (CAS) |
| `Status 100–199`, `status === "pending"`, `status_code 0/2/3` | pending | order stays PENDING |
| `Status >= 400`, `status` gagal/failed/expired, `status_code >= 4` | failed | order CANCELLED + release |
| anything else (incl. `status_code -2`) | unknown | acknowledged, **no change** ← gap for expiry |

`Order.paymentStatus` enum: `UNPAID | PENDING | PAID | FAILED | EXPIRED | REFUNDED`.
`Order.status` enum: `PENDING | PAID | PROCESSING | SHIPPED | COMPLETED | CANCELLED | REFUND_PENDING`.

### 1.5 Prisma payment fields (current)

`model Order`:

```
status            Order_status        @default(PENDING)
paymentMethod     Order_paymentMethod @default(COD)   // COD | BANK_TRANSFER | E_WALLET | QRIS
paymentStatus     Order_paymentStatus @default(UNPAID)
paidAt            DateTime?
paymentReference  String?            // our orderNumber, later the iPaymu trx_id
total             Decimal(12,2)      // server-authoritative amount
@@index([paymentStatus])
```

Missing for a direct flow: provider payment number (VA / payment code), provider URL
(QR image URL / e-wallet link), provider channel, provider expiry. There is **no**
Payment/Transaction model — payment state lives on `Order` only.

### 1.6 Customer-facing UI today

| File | Behavior |
| --- | --- |
| `app/checkout/CheckoutPage.tsx` | COD → `/api/orders`; otherwise `POST /api/payment/ipaymu` → `window.location.href = paymentData.paymentUrl` (leaves the shop) |
| `app/buy-now/BuyNowPage.tsx` | same redirect behavior for buy-now |
| `app/orders/[id]/page.tsx` | "Bayar Lagi" → `POST /api/orders/[id]/repay` → redirect to `result.data.redirectUrl` (iPaymu page) |
| `app/checkout/payment-finish/*` | Landing page after iPaymu redirect; polls `GET /api/payment/status` (3 s × 15); shows PAID / FAILED / pending. **No payment instructions.** |
| Payment method UI | 4 radios only (COD / BANK_TRANSFER / E_WALLET / QRIS). No bank or e-wallet provider picker. |

### 1.7 Expiration, rollback, cart, stock, voucher, affiliate (reused as-is)

| Concern | Implementation |
| --- | --- |
| Payment expiration (checkout side) | `cleanupPendingCheckoutOrders(userId)` — cancels the user's stale `PENDING/PENDING` non-COD orders at the next checkout attempt |
| Expiration (webhook side) | failed branch (only if provider sends `status=expired` or `status_code >= 4`; `status_code -2` is currently ignored) |
| Rollback / lifecycle | `rollbackCheckoutOrder(orderId, { restoreCart })` — atomic CAS `PENDING/PROCESSING → CANCELLED`, restores regular + flash-sale stock, `Product.sold`, `FlashSalePurchase`, voucher `usedCount` + `VoucherUserUsage`, restores the spin-wheel reward, cancels the affiliate commission |
| Cart cleanup | On settlement the webhook deletes **only** the ordered variants for `PAY-CART-*` orders; `rollbackCheckoutOrder` never restores the cart for non-COD (`restoreCart: false` semantics) |
| Stock release | `lib/order-stock.ts` → `releaseStockAndVoucherForOrder(tx, orderId)` (regular + flash-sale + voucher, idempotent guards) |
| Shipping-discount quota release | `lib/marketing/shipping-discount.ts` → `releaseShippingDiscountForOrder(tx, order)` — **used by admin cancel only**; missing from the webhook failure branch (gap, fixed in Phase 7) |
| Affiliate commission cancel | `lib/affiliate/cancel-commission.ts` → `cancelCommissionForOrder(tx, orderId, reason)` |
| Refund completion | `lib/refund.ts` → `transitionRefundForWebhook()` + `executeRefundCompletion()` |
| Repay | `lib/repay.ts` → `checkRepayEligibility()` (FAILED / EXPIRED / PENDING) + `processRepayment()` (CAS reset + re-reserve stock + re-enforce flash-sale purchase limit) |

### 1.8 Existing tests touching this integration

- `__tests__/ipaymu/ipaymu-integration.test.ts` (jest) — signature, mapping, amount,
  webhook source patterns, and assertions that the routes call `createRedirectPayment`
  and that the checkout page redirects to `paymentUrl`.
- `__tests__/ipaymu/payment-config.test.ts` (jest) — config fail-closed behavior.
- `__tests__/ipaymu/production-hardening.test.ts` (tsx script) — config, signature,
  canonical JSON, status mapping, route source patterns.
- `jest.config.js` `testMatch` covers `__tests__/ipaymu/*.test.ts` (plus marketing/p0/order-refund/security).

### 1.9 Confirmed iPaymu Direct Payment contract (documentation + official client libraries only)

Sources: official docs `docs.ipaymu.com/en/docs/payment/direct-payment`, official Go
client `github.com/ipaymu/ipaymu-go-api` (`request.go`, `response.go`, `constanta.go`,
`callback.go`), official PHP client README.

**Request — `POST {baseUrl}/api/v2/payment/direct`** (same headers/signature as redirect:
`Content-Type`, `va`, `signature`, `timestamp`)

| Field | Required | Notes |
| --- | --- | --- |
| `name`, `phone`, `email` | yes | buyer data |
| `amount` | yes | number |
| `notifyUrl` | yes | webhook URL |
| `referenceId` | yes | our `orderNumber` |
| `paymentMethod` | yes | `va` \| `qris` \| `ewallet` (also cstore/cod/cc/paylater) |
| `paymentChannel` | yes | `va`: bag, bca, bpd_bali, bni, cimb, mandiri, bmi, bri, bsi, permata, danamon, btn · `qris`: mpm (docs) / qris (Go client) · `ewallet`: dana, shopeepay |
| `expired` / `expiredType` | no | hours/days/minutes/seconds. Documented limits: QRIS cannot be customized (5 min), BCA VA 12 h fixed, BSI ≤ 3 h, BRI ≤ 2 h |
| `comments` | no | notes |
| `successUrl` / `cancelUrl` | no | only for redirect-style methods (Akulaku, credit card) |
| `product[]`, `qty[]`, `price[]` | conditional | **COD only** → not sent for va/qris/ewallet |

**Response**

```json
{ "Status": 200, "Success": true, "Message": "Success",
  "Data": { "TransactionId": 12345, "ReferenceId": "REF123456",
            "Via": "va", "Channel": "bca", "PaymentNo": "1234567890",
            "PaymentName": "BCA Virtual Account", "Total": 10000, "Fee": 0,
            "Expired": "2023-12-31 23:59:59", "Note": null,
            "Url": "https://my.ipaymu.com/payment/12345" } }
```

Confirmed `Data` members (Go `ResponseData`): `SessionId, TransactionId, ReferenceId,
Via, Channel, PaymentNo, PaymentName, Total, Fee, Expired, Note, Url`.
Semantics per docs step 3 + Go client README: **`PaymentNo` = VA / payment code to pay
to**, **`Url` = QR image URL (QRIS) / e-wallet URL**. No other field is used.

**Webhook payload (unchanged from today's normalization)**: `trx_id, sid, reference_id,
status, status_code, sub_total, total, amount, fee, paid_off, created_at, expired_at,
paid_at, via, channel, payment_no, va, buyer_name/email/phone, is_escrow,
settlement_status, transaction_status_code, additional_info`.

**Provider status codes** (Go `constanta.go`): `-2` expired · `0` pending · `1` success ·
`2` cancel · `3` refund · `4` error · `5` failed · `6` success-unsettled · `7` escrow.
(We never request escrow, so 6/7 are out of scope; 2/3 are deliberately
non-destructive — they never settle an order.)

### 1.10 Audit gaps relevant to the migration

1. **Redirect-only customer experience** — customer leaves the shop for every method.
2. **No payment instruction persistence** — nothing stores VA number / QR URL / provider channel / provider expiry, so instructions cannot be re-rendered after a refresh.
3. **`status_code -2` (documented "expired") is classified `unknown`** → an expired payment leaves the order `PENDING` reserving stock.
4. **Webhook failure branch does not release the shipping-discount quota** (admin cancel does).
5. **No customer-visible expiry countdown / expiry settlement** on our side.
6. Payment instructions are currently only obtainable by leaving the site, so browser
   polling of `GET /api/payment/status` shows nothing actionable meanwhile.

---

## PHASE 2 — DESIGN

### 2.1 Target flow

```
Customer
  ↓
Checkout (method + channel selected)
  ↓
POST /api/payment/ipaymu | /api/buy-now/ipaymu      (server-only)
  ↓ createCheckoutOrder()  →  Order PENDING / paymentStatus PENDING, stock+voucher+spin reserved
  ↓ createDirectPayment()  →  POST /api/v2/payment/direct   (server-only)
  ↓ persist instruction (paymentNo / paymentUrl / channel / expiry)
  ↓
Ecommerce payment page  /checkout/payment/{orderId}
  ├─ QRIS  : QR image (provider `Url`) + amount + order no + countdown + status
  ├─ VA    : bank + VA number (`PaymentNo`) + copy button + amount + countdown + status
  └─ E-Wallet: provider `Url` deep link when returned, otherwise the provider payment
               reference + "follow the app instructions" + countdown + status
  ↓ (page polls OUR server only: GET /api/orders/{id}/payment-status)
Customer pays (in their bank/e-wallet app or by scanning the QR)
  ↓
iPaymu webhook → POST /api/payment/ipaymu/notification
  signature → reference → amount → classification → CAS
  → PAID / (PENDING) / CANCELLED (+ release + commission cancel)
  ↓
Page polls status → shows PAID (or expired → CANCELLED)
```

Rules:
- The browser **never** talks to iPaymu and never sees API key / VA / signature.
- Amount, reference, customer data and `notifyUrl` are server-authoritative.
- Client may only choose the *method* and *channel* — validated against a server allowlist.
- Polling is UX only; only the webhook settles money (or an explicit provider expiry).

### 2.2 Method matrix

| Our method | Provider `paymentMethod` | Provider `paymentChannel` | Instruction shown in-shop | Redirect needed? |
| --- | --- | --- | --- | --- |
| `QRIS` | `qris` | `qris` (Go client) — `IPAYMU_QRIS_CHANNEL=mpm` switch for the docs value | QR image from `Data.Url`, amount, order no, expiry, status | No |
| `BANK_TRANSFER` | `va` | customer-selected: bag, bca, bpd_bali, bni, cimb, mandiri, bmi, bri, bsi, permata, danamon, btn | bank name + `Data.PaymentNo` (VA) + copy + amount + expiry + status | No |
| `E_WALLET` | `ewallet` | `dana` \| `shopeepay` | provider `Url` as a "open the app" action when present, otherwise `PaymentNo`/reference + instructions | No — only if the provider returns no usable URL do we keep a link action (still on our page) |
| `COD` | — (unchanged, `POST /api/orders`) | — | — | — |

The `qris`/`mpm` channel discrepancy is the **only** unresolved provider detail; it is
env-switchable (`IPAYMU_QRIS_CHANNEL`) and flagged as a runtime-verification item, because
both official sources are authoritative but disagree. No invented fields are used.

### 2.3 Data model (Phase 3 decision)

Direct payments need four provider facts that `Order` cannot express today. Added as
nullable columns on `Order` (no duplicate payment state, no new Payment model):

| Column | Purpose |
| --- | --- |
| `paymentNo String?` | provider VA number / payment code (`Data.PaymentNo`) |
| `paymentUrl String? @db.Text` | provider URL: QR image URL (QRIS) or e-wallet link (`Data.Url`) |
| `paymentChannel String?` | provider channel: `bca`, `mandiri`, `qris`, `dana`, … (`Data.Channel`) |
| `paymentExpiresAt DateTime?` | provider expiry (`Data.Expired`, WIB → UTC) |

`paymentReference` keeps holding our `orderNumber` / provider `trx_id`;
`paymentMethod` keeps the internal enum; `paymentStatus`/`status`/`paidAt` unchanged.
These four fields are exactly the client-safe instruction payload — nothing else from
`Data` is exposed (never `va`, never credentials).

### 2.4 API changes

| Endpoint | Change |
| --- | --- |
| `POST /api/payment/ipaymu` | Order creation unchanged; payment creation switches to `/api/v2/payment/direct`; returns `orderId`, `orderNumber`, `paymentUrl` (= our page), `paymentMethod`, `paymentChannel`, `grossAmount`, `expiresAt`, `instructions` |
| `POST /api/buy-now/ipaymu` | same switch |
| `POST /api/orders/[id]/repay` | same switch; returns `paymentUrl` (our page) instead of a provider URL |
| `GET /api/orders/[id]/payment-status` | **new** — auth + ownership; returns status + safe instruction fields from DB (polling source) |
| `POST /api/orders/[id]/expire` | **new** — server-validated expiry (provider `paymentExpiresAt` + grace) → delegates to `rollbackCheckoutOrder()` (existing lifecycle, CAS, full release) |
| `POST /api/payment/ipaymu/notification` | signature/CAS unchanged; adds `status_code -2` (expired) → failure branch, plus shipping-discount quota release in that branch |
| `GET /api/payment/status` | unchanged (order-detail/payment-finish compatibility) |

### 2.5 UI changes

| File | Change |
| --- | --- |
| `app/checkout/payment/[id]/page.tsx` + content component | **new** in-shop payment page (QRIS / VA / e-wallet instructions, copy button, countdown, status polling, expiry handling) |
| `app/checkout/CheckoutPage.tsx` | bank / e-wallet provider picker; sends `paymentChannel`; redirects to the internal payment page |
| `app/buy-now/BuyNowPage.tsx` | redirects to the internal payment page |
| `app/orders/[id]/page.tsx` | "Bayar Lagi" navigates to the internal payment page |
| `app/checkout/payment-finish/*` | unchanged (still a safe landing fallback; no payment claims) |

### 2.6 Failure / expiry

Unpaid order reaching provider expiry →
`POST /api/orders/[id]/expire` (or the webhook `expired`/`-2` notification) →
`rollbackCheckoutOrder()` → `CANCELLED` + `paymentStatus FAILED` + release regular &
flash-sale stock, `Product.sold`, `FlashSalePurchase`, voucher quota + per-user usage,
shipping-discount quota, spin-wheel reward, affiliate commission — never duplicated logic.
A grace period after the provider expiry prevents racing a payment made at the boundary;
the CAS inside `rollbackCheckoutOrder()` makes webhook-vs-expiry concurrency safe.

### 2.7 Security review points (Phase 8)

- HMAC verified against the raw body before any parsing; `timingSafeEqual`; fail-closed
  when headers or VA are missing.
- Order resolved by provider `reference_id` → must exist; amount re-checked against
  `order.total` (fee excluded); provider channel/`via` are informational only.
- CAS transitions: settlement only from `PENDING|PROCESSING` and never over
  `PAID|REFUNDED`; cancellation only from `PENDING|PROCESSING` → no resurrection of
  CANCELLED orders and no PAID → CANCELLED regression.
- No client-controlled amount, status, reference or `notifyUrl`; no provider credentials
  or merchant VA in any response (new instruction payload is built from an explicit
  allowlist of `Data` fields).
- Production config stays fail-closed (`getIpaymuConfig()` throws → 500 before any
  provider call, before any order is created).
- Browser polling can never settle an order; only the signed webhook (or a
  provider-expiry-driven cancellation) changes payment state.

### 2.8 Test plan (Phase 9)

Mocked provider (no production iPaymu calls): QRIS/VA/e-wallet direct creation (request
shape + response mapping), invalid signature, wrong amount, wrong referenceId, duplicate
webhook (CAS idempotency), webhook after cancellation (no resurrection), expiry
(`-2`), failure, success, polling before/after webhook, production config safety,
and "credentials never returned to the client".

---

## IMPLEMENTATION (PHASES 3–11)

### Phase 3 — Database

`prisma/schema.prisma` → `model Order` gained exactly the four provider facts the
instruction needs (no new Payment model, no duplicated state):

| Column | Source field |
| --- | --- |
| `paymentNo String?` | `Data.PaymentNo` (VA number / payment code) |
| `paymentUrl String? @db.Text` | `Data.Url` (QR image URL for QRIS, e-wallet link) |
| `paymentChannel String?` | `Data.Channel` |
| `paymentExpiresAt DateTime?` | `Data.Expired` (WIB → UTC) |

plus `@@index([paymentExpiresAt])`.
Migration: `prisma/migrations/20260918000000_add_order_direct_payment_instruction/migration.sql`.

**NOT applied to any database.** `prisma validate` + `prisma generate` were run locally;
`prisma migrate deploy` / `migrate dev` were deliberately NOT run (production data).
Applying this migration is a required, separately-approved deployment step.

### Phase 4 — Backend

| File | Change |
| --- | --- |
| `lib/payment/ipaymu.ts` | `createRedirectPayment()` REMOVED, replaced by `createDirectPayment()` (POST `/api/v2/payment/direct`) on a shared `postToIpaymu()` (signature, headers, 30 s timeout, error taxonomy). Added channel allowlists + `resolveProviderMethod()`, `resolveQrisChannel()`, `buildPaymentInstruction()`, `sanitizeProviderUrl()` / `sanitizeQrImageUrl()`, `parseIpaymuExpiredAt()` (WIB→UTC), `isExpiryNotification()`; status classification now treats the documented `-2` (expired) as failure. Webhook signature verification is untouched. |
| `lib/payment/order-payment.ts` (new) | `createDirectOrderPayment()` (resolve channel → provider call → sanitize → persist), `savePaymentInstruction()`, `loadPaymentView()` (client-safe read model), `getPaymentPagePath()`, `expireUnpaidOrderIfExpired()` (delegates to `rollbackCheckoutOrder()`), `PAYMENT_EXPIRY_GRACE_MS`. |
| `app/api/payment/ipaymu/route.ts` | Order creation unchanged; direct payment + persisted instruction; returns our own `paymentUrl`; channel validated before any order exists. |
| `app/api/buy-now/ipaymu/route.ts` | Same switch. |
| `app/api/orders/[id]/repay/route.ts` | Same switch; returns our own `paymentUrl`. |
| `app/api/orders/[id]/payment-status/route.ts` (new) | Auth + ownership; DB-only status/instruction for polling; never mutates. |
| `app/api/orders/[id]/expire/route.ts` (new) | Server-validated expiry settlement through the existing lifecycle CAS. |
| `app/api/payment/ipaymu/notification/route.ts` | `status_code -2` mapped to the failure branch; the amount check now also runs for payloads that only carry `sub_total`; failure/expiry now also releases the shipping-discount quota. Signature/amount/CAS/refund logic otherwise unchanged. |

Amount, reference, buyer data and `notifyUrl` stay server-authoritative; the client may only
pick a method + an allowlisted channel.

### Phase 5/6 — UI + status

- `app/checkout/payment/[id]/page.tsx` (new): in-shop payment page — QRIS QR image (with
  fallback + link), VA bank + number + copy button, e-wallet action link/code, amount,
  order number, countdown, status, TikTok CompletePayment on PAID.
- `app/checkout/CheckoutPage.tsx` / `app/buy-now/BuyNowPage.tsx`: bank / e-wallet channel
  pickers; send `paymentChannel`; navigate to the internal payment page.
- `app/orders/[id]/page.tsx`: "Bayar Lagi" navigates to the internal payment page.
- `next.config.ts`: CSP `img-src` allows the iPaymu QR hosts (`my.ipaymu.com`,
  `sandbox.ipaymu.com`) in addition to the existing `data:` allowance.
- Polling is UX only (`GET /api/orders/[id]/payment-status`); the browser never calls
  iPaymu.

### Phase 7 — Failure / expiration

Unpaid order + provider expiry (+5 min grace) → `POST /api/orders/[id]/expire` or the
webhook `expired`/`-2` → `rollbackCheckoutOrder()` → `CANCELLED` + `paymentStatus FAILED` +
stock / flash-sale stock / `Product.sold` / `FlashSalePurchase` / voucher quota + per-user
usage / spin-wheel reward / shipping-discount quota / affiliate commission release. No
rollback logic was duplicated.

### Phase 9 — Tests

- `__tests__/ipaymu/direct-payment.test.ts` (new, 37 tests): QRIS/VA/e-wallet creation,
  invalid signature, missing headers, wrong amount (incl. `sub_total`-only payloads), wrong
  referenceId, duplicate webhook, webhook after cancellation, expiry (`-2`), failure,
  success, polling before/after the webhook, expiry settlement (open window / grace /
  expired / paid / no expiry), production config safety, credential non-exposure.
  Provider API fully mocked; the mock asserts the only endpoint contacted is
  `https://sandbox.ipaymu.com`.
- `__tests__/ipaymu/ipaymu-integration.test.ts`: redirect assertions replaced with direct
  payment assertions (routes/cart/repay, no provider URL returned, channel sent, new page
  exists, page never settles payment).
- `__tests__/ipaymu/production-hardening.test.ts`: redirect-era assertions replaced with
  direct-payment ones (allowlists, no rounding, expiry classification, shipping-discount
  release, sanitizers).

### Phase 8 — Security verification (implemented)

HMAC over the raw body with `timingSafeEqual`; missing headers/VA → 401; amount compared
against `order.total` whenever any amount field is present; unknown order → acknowledged,
no change; settlement only from `PENDING|PROCESSING` and never over `PAID|REFUNDED`;
cancellation only from `PENDING|PROCESSING` (no resurrection, no PAID → CANCELLED);
provider payloads reduced to an explicit allowlist before persisting/returning; provider
URLs restricted to http(s)/raster data URIs; production config resolution is fail-closed
before any provider call.

### Outstanding runtime verification (Phase 10)

1. Apply the migration in the target environment.
2. QRIS: confirm the returned `Data.Url` host (CSP + `<img>`), and whether
   `IPAYMU_QRIS_CHANNEL=mpm` is required instead of the default `qris`.
3. VA: confirm `Data.PaymentNo` is the customer VA for the selected bank.
4. E-wallet: confirm whether `Data.Url` is a usable in-page action (deep link / web URL)
   for `dana` / `shopeepay`.
5. Confirm the real `Expired` format/timezone and the QRIS 5-minute window against the
   countdown + grace behaviour.
6. Confirm the webhook header set (`X-Signature`, `X-Timestamp`, `X-External-ID`) against a
   live notification, and that expiry arrives as `status_code -2` and/or `status=expired`.
7. End-to-end: pay → webhook → page flips to PAID; expire → page shows expired and stock /
   voucher / shipping-discount quota are released.
