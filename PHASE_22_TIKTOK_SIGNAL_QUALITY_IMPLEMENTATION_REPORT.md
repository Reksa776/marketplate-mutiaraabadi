# PHASE 22 — TIKTOK SIGNAL QUALITY HARDENING

Implementation report. Audit-only findings were addressed without resetting or
discarding any existing TikTok work in the tree.

---

## 1. ROOT CAUSES FIXED

| # | Root cause (from the audit) | Fix |
|---|---|---|
| 1 | Browser Advanced Matching ran on its own timeline; events could fire before identity was applied | Shared identity store (`lib/analytics/tiktok-identity.ts`) + `whenTikTokReadyForEvents()`; every event component now waits for identity before the event |
| 2 | Browser was fed SHA-256 digests into `ttq.identify()`, which the Pixel hashes again | Browser now receives normalized RAW values (documented Pixel contract); server Events API keeps SHA-256 |
| 3 | `ttclid` never captured or persisted | Captured from the landing URL into a first-party cookie, read at order creation, stored + forwarded |
| 4 | `_ttp` never captured | Read from TikTok's own cookie when present (never fabricated), persisted + forwarded |
| 5 | Attribution lost at checkout | `readOrderAttribution()` at every order-creation route; persisted on `Order` |
| 6 | No customer IP / user-agent | Captured from the customer request via `getClientIp()` + `User-Agent`; webhook IP/UA never used |
| 7 | Server CompletePayment had no attribution | Forwards stored `ttclid` / `ttp` / `ip` / `user_agent` / `page.url` |
| 8 | Email/phone/external_id hashing | Preserved on the server path (unchanged) |
| 9 | CompletePayment browser/server dedup | Preserved: `ttq:completepayment:<orderNumber>` unchanged everywhere |
| 10 | Regression coverage | New `__tests__/security/tiktok-attribution.test.ts` (42 tests) + updated matching tests |

---

## 2. DOCUMENTED CONTRACT — browser vs server hashing

Verified against TikTok's own guidance ("customer emails and phone numbers will
be hashed with SHA256 … before reaching TikTok servers"):
**the browser Pixel hashes client-side**, so `ttq.identify()` takes the
normalized **RAW** value. The **Events API** is the opposite and takes the
SHA-256 digest. Passing a digest to the Pixel double-hashes it and matches
nobody.

Consequence: `/api/analytics/tiktok-match` now returns normalized raw
identifiers (session-protected, `no-store`, own user only). The server Events
API continues to hash with `buildTikTokUserMatch()`. This is covered by a
regression test.

---

## 3. FILES CHANGED

**New**
- `lib/analytics/attribution.ts` — first-party attribution capture/parse/serialize (client + server safe)
- `lib/analytics/attribution-server.ts` — `server-only` order-boundary reader (cookie + trusted IP + UA)
- `lib/analytics/tiktok-identity.ts` — shared browser identity readiness store + `whenTikTokReadyForEvents()`
- `components/analytics/TikTokAttribution.tsx` — client capture component
- `prisma/migrations/20260926000000_add_order_tiktok_attribution/migration.sql`
- `__tests__/security/tiktok-attribution.test.ts`
- `.gitattributes` — `lib/checkout.ts whitespace=cr-at-eol` so `git diff --check` reports real whitespace issues, not the legacy CRLF convention of that one file
- `PHASE_22_TIKTOK_SIGNAL_QUALITY_IMPLEMENTATION_REPORT.md`

**Modified**
- `prisma/schema.prisma` — six nullable `Order` attribution columns
- `lib/checkout.ts` — `CreateCheckoutInput.attribution` persisted in `order.create`
- `lib/analytics/tiktok-user-match.ts` — added `buildTikTokBrowserMatch()` (raw) + type
- `app/api/analytics/tiktok-match/route.ts` — returns normalized raw identifiers
- `components/analytics/TikTokAdvancedMatching.tsx` — raw identify + identity settlement
- `components/analytics/AnalyticsProvider.tsx` — mounts `TikTokAttribution`
- `components/analytics/PurchaseTracker.tsx` — waits for identity
- `components/products/ProductDetail.tsx` — waits for identity (ViewContent + AddToCart)
- `app/checkout/CheckoutPage.tsx` — waits for identity (InitiateCheckout + AddPaymentInfo)
- `app/buy-now/BuyNowPage.tsx` — waits for identity (InitiateCheckout + AddPaymentInfo)
- `app/checkout/payment/[id]/page.tsx` — waits for identity (CompletePayment)
- `app/checkout/payment-finish/payment-finish-content.tsx` — waits for identity (CompletePayment)
- `lib/analytics/tiktok-events-api.ts` — forwards `ttclid`/`ttp`/`ip`/`user_agent`/`page_url`
- `app/api/orders/route.ts`, `app/api/payment/ipaymu/route.ts`, `app/api/buy-now/route.ts`, `app/api/buy-now/ipaymu/route.ts` — capture attribution at the boundary
- `app/api/payment/ipaymu/notification/route.ts`, `app/api/payment/midtrans/notification/route.ts` — forward stored attribution
- `__tests__/security/tiktok-advanced-matching.test.ts` — updated to the new browser/server contract

**Preserved untouched:** the pre-existing uncommitted TikTok work (Pixel config,
access token, catalog, security tests) — only extended, never reset.

---

## 4. SCHEMA CHANGES

Additive and non-destructive (`prisma/migrations/20260926000000_add_order_tiktok_attribution/migration.sql`),
six NULLABLE columns on `order`:

| Column | Meaning |
|---|---|
| `ttclid` | `?ttclid=…` from the first landing URL |
| `ttp` | TikTok's own `_ttp` cookie value, when present |
| `landingUrl` | first landing URL of the visit |
| `referrer` | first referrer of the visit |
| `clientIp` | customer request IP (trusted-proxy aware) |
| `clientUserAgent` | customer request User-Agent |

No backfill, no data dropped, no existing column changed. NULL is the honest
value for non-TikTok traffic.

---

## 5. ATTRIBUTION FLOW

```
Landing (?ttclid=…)            [browser]
  → TikTokAttribution (useEffect on every route change)
     → capture ttclid + _ttp + landingUrl + referrer
     → persist first-party cookie `tt_attr` (first touch wins; _ttp refreshed)

Checkout / buy-now / COD       [customer request boundary]
  → readOrderAttribution(request)
     → parse `tt_attr` cookie
     → clientIp = getClientIp(request)   (trusted-proxy aware; "untrusted" → null)
     → clientUserAgent = request User-Agent (bounded, control-stripped)
  → createCheckoutOrder({ …, attribution })
     → persisted on the Order row

Settlement webhook             [server, authoritative]
  → reads ONLY the persisted Order attribution
  → forwards it to Events API CompletePayment
```

Repayment reuses the same `Order` row, so attribution survives a payment-flow
change automatically. No attribution is duplicated.

---

## 6. BROWSER IDENTITY FLOW

```
useSession status
  ├─ "loading"        → wait (bounded)
  ├─ not authenticated → settleTikTokIdentity(null)     (anonymous, never blocked)
  └─ authenticated
       → GET /api/analytics/tiktok-match (once per page load, no-store)
       → normalized RAW identifiers
       → whenTikTokPixelReady → trackTikTokUserMatch() (ttq.identify)
       → on success: settleTikTokIdentity(identifiers)

Event components:
  whenTikTokReadyForEvents(cb)
      = whenTikTokIdentitySettled(cb)  then  whenTikTokPixelReady(cb)
```

- Authenticated events now deterministically carry identity.
- Anonymous visitors are settled immediately — **no new global blocking**.
- A never-settling identity times out (4s) so events are never lost.

---

## 7. SERVER COMPLETEPAYMENT FLOW

Unchanged settlement semantics. Only the payload gained verified attribution:

```
event:    "CompletePayment"
event_id: "ttq:completepayment:<orderNumber>"          (unchanged)
properties: value, currency=IDR, order_id, content_type, contents[]
user:
  email / phone / external_id   → SHA-256 (unchanged, hashed server-side)
  ttclid / ttp                  → unhashed (from the stored Order)
  ip / user_agent               → unhashed (customer boundary, NOT the webhook)
page: { url }                   → stored landingUrl when available
```

The atomic PAID CAS, signature validation, amount validation and duplicate
webhook handling are untouched.

---

## 8. SECURITY CONSIDERATIONS

- Raw email/phone are **never** sent to the server Events API, never logged,
  never placed in the request body unhashed.
- The browser now receives its OWN normalized identifiers (session-protected,
  `no-store`, no secret columns) — required by the documented Pixel contract.
- The iPaymu/Midtrans **webhook IP and User-Agent are never used** as the
  customer's; only the values persisted at the customer request boundary are
  forwarded. Enforced by tests.
- `ttclid`/`ttp` are sanitized (control-stripped, length-bounded); only
  absolute `http(s)` URLs are persisted.
- `getClientIp()` returns `"untrusted"` without `TRUSTED_PROXY`; it is stored as
  `null` rather than a spoofable value.
- No `console.log` of PII; no secret (Access Token) exposed client-side.

---

## 9. TESTS

New: `__tests__/security/tiktok-attribution.test.ts` — 42 tests covering
identity readiness (incl. timeout), browser raw vs server hashed semantics,
email/phone/external_id normalization, `ttclid` capture + first-touch + cookie
persistence, `_ttp` capture/absence, cookie sanitization, customer IP + UA,
webhook-IP/UA exclusion, CompletePayment attribution forwarding, hashed PII
preservation, stable `event_id`, browser/server dedup, anonymous ViewContent,
and attribution persistence through order creation.

Updated: `__tests__/security/tiktok-advanced-matching.test.ts` — reflects the
documented browser contract and the identity-aware waiting helper.

---

## 10. VERIFICATION RESULTS

| Command | Result |
|---|---|
| `npx prisma validate` | ✅ schema valid |
| `npx prisma migrate status` | ✅ only the new additive migration was pending; applied via `prisma migrate deploy` (additive, no reset) |
| `npx tsc --noEmit` | ✅ no type errors |
| `npx eslint .` | ⚠️ 412 pre-existing problems repo-wide (`server.js` require, audit/test scripts); **no new errors in the changed/new files** |
| `npx jest --runInBand` | ✅ 1069 passed, 4 skipped, **2 failed** — both pre-existing/environmental in `__tests__/p0/remediation.integration.test.ts` (a 5s Prisma interactive-transaction timeout in the affiliate payout route; a raw-SQL chart timezone assertion). Neither imports or exercises any changed file. |
| `npm run build` | ✅ build succeeded |
| `git diff --check` | ✅ clean |

Targeted suites: `tiktok-attribution.test.ts` 42/42, `tiktok-advanced-matching.test.ts` 45/45.

---

## 11. REMAINING TIKTOK CATALOG MANAGER CONFIGURATION

Application-side only was changed. Still required in **TikTok Ads Manager /
Catalog Manager** (out of scope, not performed):

1. Create and connect a product catalog to the pixel.
2. Publish a feed whose item ids equal the `content_id` the app emits today —
   `Product.id` (the resolver already prefers a real `sku` if a column is added
   later).
3. Enable Automatic Advanced Matching (and optionally keep Manual) in the
   Pixel settings so browser identity is maximized.

No catalog was created, no fake order was created, no production webhook was
sent.

---

## FINAL FLAGS

```
COMMIT:             NO
PUSH:               NO
DATABASE RESET:     NO   (only an additive migration was applied)
PRODUCTION WEBHOOK: NO
```
