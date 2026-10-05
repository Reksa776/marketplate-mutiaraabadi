# TikTok Tracking Audit — No Payment Required

**Mode:** READ-ONLY audit. No payment, no webhook simulation, no DB write, no migration, no commit, no push, no deploy, no `.env` output, no secret output.

**Scope:** TikTok Pixel, Advanced Matching, Events API, CompletePayment, event_id/dedup, email/phone/external_id hashing, user & order identity, payment webhook relationship, `test_event_code`, and production vs local environment differences.

**Verification run during audit:** `npx jest __tests__/security/tiktok-` → **11 suites / 325 tests passed** (this only exercises pure logic + mocked providers; it executes no payment and no real TikTok call).

---

## 1. Executive Summary

The implementation is **architecturally sound and safe to test without payment**.

- Advanced Matching is implemented correctly: raw email / phone / external_id are normalized (email trim+lowercase, phone E.164 `+62…`) and **SHA-256 hashed server-side only** (`lib/analytics/tiktok-user-match.ts`). The browser never receives raw PII — `/api/analytics/tiktok-match` returns **64-char SHA-256 digests only** for the authenticated caller.
- Server Events API (`lib/analytics/tiktok-events-api.ts`) sends `data[].user` with hashed `email` / `phone` / `external_id`, plus unhashed attribution (`ttclid`, `ttp`, `ip`, `user_agent`). It is `server-only`, never throws, and logs key **names** only — never values.
- `CompletePayment` is sent from an **authoritative CAS-guarded payment settlement webhook** (iPaymu + Midtrans) and, independently, from browser confirmation pages — **both using the same deterministic `event_id` (`ttq:completepayment:<orderNumber>`)** for deduplication.
- `TIKTOK_TEST_EVENT_CODE` is server-side only, optional, never `NEXT_PUBLIC_*`, never logged. Its absence locally is a **normal environment difference**, not a bug.
- The TikTok diagnostic *"Email and phone are missing" / ~66.67% affected* is **most consistent with anonymous public browsing** (PageView + ViewContent on product pages before login), which legitimately carry no identity by design — not with a broken identifier path.

No CRITICAL security issue found. The few issues below are quality/behavioural, not payment-safety issues.

---

## 2. Current Architecture

Source of truth:

| Identity | Source of truth | Notes |
|---|---|---|
| email | `User.email` (`String?`, nullable) | account email; null for phone-only accounts |
| phone | `User.phone` (`String?`) with fallback to `Order.phone` (`String`, required, captured at checkout) | server path uses `user.phone ?? order.phone` |
| external_id | `User.id` == `Order.userId` (stable) | hashed SHA-256 |

Flow map:

```
Customer
  → Login / Session (NextAuth)            auth()
  → Email / Phone                         User.email / User.phone (DB)
  → Browse product  → ViewContent (browser, public/anonymous allowed)
  → AddToCart       → AddToCart (browser, requires login)
  → Checkout        → InitiateCheckout (browser, requires login)
  → Submit order    → AddPaymentInfo (browser)
  → Order (DB)      → Order.userId, Order.phone, Order.* (attribution)
  → Payment initiation → provider (iPaymu / Midtrans)
  → Payment webhook → atomic CAS PENDING/PROCESSING → PAID
  → PAID            → trackTikTokServerCompletePayment (server Events API)
  → Confirmation page → browser CompletePayment (same event_id)
```

Browser identity pipeline (deliberate ordering):

```
TikTokPixel (base code, ttq.page stripped)
    ↓ ready
TikTokAdvancedMatching → GET /api/analytics/tiktok-match (authenticated only, digests)
    ↓ ttq.identify(digests) applied
identity store settles → eligible events fire via whenTikTokReadyForEvents()
```

---

## 3. Browser Pixel Flow

**A. Active?** Yes, when `StoreSetting.tiktokPixelEnabled` is true AND the stored base code reduces to executable JS. `lib/analytics/tiktok-config.ts`.

**B. Pixel ID source?** `StoreSetting.tiktokPixelId` (normalized, `^[A-Z0-9]{10,30}$`). The executable script comes from `StoreSetting.tiktokPixelCode` (admin base code, `<script>` tags stripped). It is passed server → client via a server component (`components/analytics/AnalyticsProvider.tsx`). The **Access Token is never included**.

**C/D. Advanced Matching / `ttq.identify()`?** Yes. `components/analytics/TikTokAdvancedMatching.tsx` + `lib/analytics/tiktok-browser-identity.ts` + `lib/analytics/tiktok.ts:trackTikTokUserMatch()`. The Pixel is fed **SHA-256 digests** (defence-in-depth: `isTikTokMatchDigest` rejects anything that is not 64-hex before forwarding).

**E/F. Email/phone available at identify?** Only for an **authenticated, non-admin** visitor, fetched from `/api/analytics/tiktok-match` (which hashes `User.email` / `User.phone`). Anonymous visitors are settled as `null` and events still fire.

**G. Can identifiers be null?** Yes, by design: anonymous visitors, users without email, or users without phone. The code omits unusable keys entirely — **never an empty string, never hash-of-nothing**.

**H. Identifiers before events?** Yes. `whenTikTokReadyForEvents()` waits for both identity settlement and pixel readiness before dispatching.

**I. Identity only after login?** Correct — the endpoint returns `{}` for anonymous callers.

**J. Guest handling?** Guests still get PageView/ViewContent with **no fabricated identifier**.

### Event inventory

| Event | When sent | Channel | email | phone | external_id | event_id |
|---|---|---|---|---|---|---|
| PageView | every non-admin navigation (after identity settles) | browser only | if authenticated | if authenticated | if authenticated | none (intentional) |
| ViewContent | product detail mount | browser only | if authenticated | if authenticated | if authenticated | none |
| AddToCart | successful add (requires login) | browser only | normally yes | normally yes | normally yes | none |
| InitiateCheckout | checkout data loaded | browser only | normally yes | normally yes | normally yes | none |
| AddPaymentInfo | order submit | browser only | normally yes | normally yes | normally yes | none |
| CompletePayment | confirmation page / PAID view | browser | from Order→User digests | from Order→User digests | yes | `ttq:completepayment:<orderNumber>` |
| CompletePayment | webhook CAS settled | server | hashed | hashed | hashed | same |

---

## 4. Server Events API Flow

Single sender: `lib/analytics/tiktok-events-api.ts` → `POST https://business-api.tiktok.com/open_api/v1.3/event/track/` with header `Access-Token: <token>` (secret, never logged). No other module calls TikTok.

Safe payload structure (values shown as shapes, no real digests):

```jsonc
{
  "event_source": "web",
  "event_source_id": "<pixel id>",
  "test_event_code": "<present ONLY when env var set>",
  "data": [{
    "event": "CompletePayment",
    "event_time": 1760000000,
    "event_id": "ttq:completepayment:<orderNumber>",
    "properties": { "value": 0, "currency": "IDR", "order_id": "<orderNumber>", "contents": [ ... ] },
    "page": { "url": "<stored landing url>" },
    "user": {
      "email":        "<sha256 hex>",
      "phone":        "<sha256 hex>",
      "external_id":  "<sha256 hex>",
      "ttclid": "...", "ttp": "...", "ip": "...", "user_agent": "..."
    }
  }]
}
```

Checklist answers:

1. **Email normalization** — `normalizeTikTokMatchEmail`: trim + lowercase, max 254 chars, must match `^[^\s@]+@[^\s@]+\.[^\s@]+$`, else dropped.
2. **Phone normalization** — `normalizeTikTokMatchPhone`: digits only, E.164 `+62…` for Indonesian shapes (`+62`, `62…`, `0…`, `8…`), strip stray trunk `0` after `62`, length 8–15 digits, else dropped.
3. **SHA-256 location** — `sha256TikTokMatch()` in `lib/analytics/tiktok-user-match.ts` (Node `crypto.createHash("sha256")`).
4. **Hashed before request?** Yes — hashing is done in the `user` builder before `fetch`.
5. **Raw email to browser?** Never. Endpoint returns digests only; `digestOnly()` is a second filter.
6. **Raw phone to browser?** Never (same reason).
7. **Raw PII in logs?** No. Logs include `event`, `event_id`, HTTP status, TikTok `code`/`message`/`request_id`, `testEventCodeConfigured`, and **`userKeys` (names only)**.
8. **NULL/empty filtered?** Yes — `buildTikTokUserMatch` omits unusable keys; `hasTikTokUserMatch` gates attachment; `data[].user` is attached only when at least one usable value exists.
9. **external_id hashed?** Yes (`hashTikTokMatchExternalId`, trimmed then SHA-256).
10. **event_id deterministic?** Yes — `buildTikTokEventId(event, reference)` → `ttq:<event_lowercased>:<reference>`.

---

## 5. CompletePayment Flow

1. **What triggers it (server)?** The payment settlement webhook CAS actually transitioning the order to `PAID`.
2. **From success page?** Also yes (browser) — the COD confirmation page.
3. **From client?** Yes (confirmation / PAID views).
4. **From server?** Yes (webhook), authoritative.
5. **From payment webhook?** Yes, and only there server-side, after settlement.
6. **Must webhook be PAID?** Yes — sender runs only inside `if (settled)`.
7. **CAS/transaction guard?** Yes:

   ```sql
   UPDATE `order` SET status='PAID', paymentStatus='PAID', paidAt=…, paymentReference=…
   WHERE id = ? AND status IN ('PENDING','PROCESSING')
     AND paymentStatus NOT IN ('PAID','REFUNDED')
   ```
   `settled = true` only when `affectedRows > 0`. `app/api/payment/ipaymu/notification/route.ts` (~L425–548), same pattern in `midtrans/notification/route.ts` (~L473–486).
8. **Duplicate webhook → duplicate CompletePayment?** No. A replay hits `affectedRows === 0`, `settled` stays false, and the sender is never called.
9. **Same event_id browser/server?** Yes: `ttq:completepayment:<orderNumber>` on both channels.
10. **Email from?** `existingOrder.user?.email` (server) / `order.user?.email` (browser pages).
11. **Phone from?** `order.user?.phone ?? order.phone` (both server and browser).
12. **Available at that point?** Email may be null for phone-only accounts; phone is available because `Order.phone` is required and used as fallback.

**Verdict on `webhook → authoritative PAID → CompletePayment`:** the architecture is correct and payment-authoritative. No payment is required to verify the *sender* (see §13).

---

## 6. Email Matching Flow

`User.email` → (read at order/confirmation time) → `normalizeTikTokMatchEmail` (trim+lowercase) → `sha256TikTokMatch` → `user.email` (Events API) / `email` (browser `ttq.identify`). Omitted when null/invalid. `email` can be null → matching email absent (see §12 CASE 3).

## 7. Phone Matching Flow

`User.phone ?? Order.phone` → `normalizeTikTokMatchPhone` (E.164 `+62…`) → `sha256TikTokMatch` → `user.phone` (Events API) / `phone_number` (browser). Omitted when null/unplaceable. Note the browser key is `phone_number` — correctly mapped in `buildTikTokBrowserMatch`.

## 8. External ID Flow

`User.id` (== `Order.userId`) → `hashTikTokMatchExternalId` (trim) → `sha256TikTokMatch` → `external_id` on both channels. Consistent by construction, because the browser sends the digest the server produced (`/api/analytics/tiktok-match`, `payment/status`, order pages).

## 9. Event ID / Deduplication

- Builder: `buildTikTokEventId("CompletePayment", orderNumber)` → `ttq:completepayment:<orderNumber>`.
- **Browser CompletePayment** (`components/analytics/PurchaseTracker.tsx`) and **server CompletePayment** (`trackTikTokServerCompletePayment`) use the exact same value.
- PageView intentionally carries **no** event_id (no server counterpart; a stable id would suppress repeat visits).
- Other browser events also carry no event_id.
- Duplicate webhook cannot produce a *different* id (deterministic from order number) and cannot produce a *second* server event (CAS). ✅

## 10. `TIKTOK_TEST_EVENT_CODE` Environment Handling

- Read **only** by `getTikTokTestEventCode()` in `lib/analytics/tiktok-test-event-code.ts` (from `process.env.TIKTOK_TEST_EVENT_CODE`), normalized (≤64 chars, `^[A-Za-z0-9_-]+$`).
- Consumed **server-side** by `lib/analytics/tiktok-events-config.ts` (which is `server-only`) and by the standalone `scripts/tiktok-events-api-check.ts`.
- Added to the request at the **top level** as `test_event_code` (only when set). Absent ⇒ production body is byte-for-byte unchanged.
- Never `NEXT_PUBLIC_*`; never returned to the client; never logged (only `testEventCodeConfigured: boolean`).
- Optional and undefined-safe: `config.testEventCode !== null` handling; no throw when unset.
- **Local without the variable is a documented, normal environment difference — not a source bug.**

## 11. Local vs VPS Environment Differences

| Variable | Local | VPS | Classification | Impact |
|---|---|---|---|---|
| `TIKTOK_TEST_EVENT_CODE` | absent (per audit statement) | present | test-only / server-only (not a credential, but not client-safe) | With it set, server events route to Events Manager "Test Events". Without it, server events count as real reporting. **No functional failure either way.** |
| `DATABASE_URL` | present (local DB) | present (prod DB) | secret | Resolves StoreSetting pixel config. Never printed. |
| `TIKTOK_PIXEL_ID` (as data, not env) | in `StoreSetting` | in `StoreSetting` | public/client-safe | Pixel ID ships in storefront base code; safe. |
| `TIKTOK_PIXEL_ACCESS_TOKEN` (as data) | in `StoreSetting` | in `StoreSetting` | secret/server-only | Never sent to browser; admin UI shows only `••••last4` + configured flag. |

Note: the audit did **not** read, copy, or print any `.env` value.

## 12. Root Cause Analysis — 66.67% Missing Email/Phone

| Case | Scenario | Can produce diagnostic? |
|---|---|---|
| CASE 1 | Guest/anonymous → PageView / ViewContent sent with no identity | **Yes — most likely.** These events are public by design and carry no fabricated keys. |
| CASE 2 | Logged-in with email + phone → identity present | No |
| CASE 3 | Logged-in, email present, phone NULL → email only | **Yes** — TikTok reports the missing phone. |
| CASE 4 | Logged-in, phone present, email NULL → phone only | **Yes** — TikTok reports the missing email. |
| CASE 5 | Logged-in, both present → CompletePayment both present | No |

Likely event mix explaining ~66.67% (2/3 or 4/6): a test session of `PageView` + `ViewContent` as a guest (or before identity settled) plus one or more identified events. **4 identified/missing out of 6 total events = 66.67%** is consistent with CASE 1 dominating, not with a broken hashing/identity path. Do **not** conclude the implementation is broken from the percentage alone — the source shows the identity path works for authenticated users with both fields.

## 13. Safe No-Payment Test Plan

### LEVEL A — LOCAL, NO NETWORK (already automated)
Run `npx jest __tests__/security/tiktok-` (11 suites, 325 tests, all passing). Covers email normalization, phone normalization, SHA-256, external_id, event_id, payload builder, skip reasons, dedup, and observability logging. No network, no DB, no payment.

### LEVEL B — LOCAL / SAFE INTEGRATION
- Browser Pixel: run `npm run dev`, open the store, use the **TikTok Pixel Helper** extension and the browser Network tab to confirm `ttq.identify()` is called with digests before events.
- Identity: log in with a test account that has **both email and phone**; open DevTools → Network → `GET /api/analytics/tiktok-match` should return `{success:true, data:{email:"<64hex>", phone_number:"<64hex>", external_id:"<64hex>"}}` (digests only). Anonymous call should return `{success:true, data:{}}`.
- AddToCart / InitiateCheckout / AddPaymentInfo: trigger from a logged-in session; confirm each `ttq.track(...)` fires after identify. **No payment needed.**
- Server payload without sending: call `sendTikTokEvent()` in a unit test / mocked fetch and inspect the built body (as the existing suites do); no TikTok call, no order state change.

### LEVEL C — VPS / TEST EVENTS (only if TikTok-side acceptance must be proven)
- Run `npm run audit:tiktok` (read-only) first — reports whether the process sees the pixel config and whether `TIKTOK_TEST_EVENT_CODE` is visible, **without printing any secret**.
- Then `npm run audit:tiktok -- --send` posts **one** `CompletePayment` probe with a **synthetic** reference (`TIKTOK-DIAGNOSTIC-<ts>-<nonce>`), **no PII, no order data, no DB write**. With the env var set it lands in Events Manager → Test Events.
- Observe acceptance (`code: 0`). This proves server-side delivery and test-code routing **without any payment**.
- If browser events must also appear in Test Events, a **new** design is required (see Finding F4) — do **not** implement it during this audit.

### LEVEL D/E (covered by A + B)
Payload generation and hashing are fully testable offline; `/api/analytics/tiktok-match` proves identity resolution end-to-end **without** any payment.

## 14. Security Findings

- ✅ Access Token is `server-only`, read from `StoreSetting`, omitted from `SETTINGS_SELECT` (`app/api/admin/settings/route.ts`), exposed only as `tiktokPixelAccessTokenConfigured` + `tiktokPixelAccessTokenLast4`.
- ✅ `TIKTOK_TEST_EVENT_CODE` never reaches the client bundle (no `NEXT_PUBLIC_*`, no client import of the config module).
- ✅ Raw email/phone never logged; logs expose `userKeys` names only.
- ✅ `/api/analytics/tiktok-match` returns the caller's own digests only (session-scoped, `no-store`).
- ✅ Webhook remains payment-authoritative; no bypass path in the TikTok sender (it only reads config and posts; it never touches order state).
- ✅ No debug endpoint returns PII or can forge a production `CompletePayment`; the probe carries no identity and does not mutate state.
- ✅ `ttq.identify()` rejects non-digest values (`isTikTokMatchDigest`), so a tampered/compromised match response cannot smuggle raw PII to the Pixel.

## 15. Findings

### F1 — Anonymous public events carry no email/phone (likely diagnostic cause) — INFO
- **File/function:** `lib/analytics/tiktok-pageview.ts`, `components/products/ProductDetail.tsx` (`ViewContent`), identity gate in `lib/analytics/tiktok-identity.ts`.
- **Problem:** PageView/ViewContent are sent for anonymous visitors with no matching keys.
- **Impact:** TikTok reports missing identifiers on those events; accounts for most of a 66.67% figure.
- **Recommendation:** Expected behaviour — no fix required. Optionally document expected anonymous share in analytics onboarding.

### F2 — Phone-only or email-only accounts yield partial matching — MEDIUM
- **File:** `prisma/schema.prisma` (`User.email String?`, `User.phone String?`), `lib/analytics/tiktok-user-match.ts`.
- **Problem:** Registration/login does not guarantee both email and phone. A user with only one identifier produces partial matching.
- **Impact:** TikTok flags the missing field per event.
- **Recommendation:** If match rate must improve, consider collecting phone at checkout for all payment methods (Order.phone already exists) and preferring it as the phone source for browser/server identity. Do not change during this read-only audit.

### F3 — Browser CompletePayment is not gated on `paymentStatus` on the COD success page — MEDIUM
- **File:** `app/checkout/success/page.tsx` (~L120–165), `components/analytics/PurchaseTracker.tsx`.
- **Problem:** The success page renders `<PurchaseTracker>` unconditionally after ownership checks; no `paymentStatus === "PAID"` guard. `/checkout/success` is the COD path, but it is reachable by URL for any owned (possibly PENDING) order.
- **Impact:** A crafted visit to `/checkout/success?order=<pending order>` could send a premature browser `CompletePayment` with `ttq:completepayment:<orderNumber>`; TikTok keeps the first event, so the later authoritative server event could be suppressed within the 48h dedup window.
- **Recommendation:** Add a `paymentStatus === "PAID"` (or COD) guard before rendering `PurchaseTracker`, or move the COD browser event to a COD-specific assertion. Do not implement until approved.

### F4 — Browser Pixel receives no `test_event_code` — INFO
- **File:** `lib/analytics/tiktok-test-event-code.ts`, `lib/analytics/tiktok-events-api.ts` (test code added server-side only).
- **Problem:** Only the server Events API path supports `test_event_code`; browser events cannot be routed to Events Manager "Test Events" from app code.
- **Impact:** Level C browser testing relies on the Pixel Helper and may count as real traffic.
- **Recommendation:** Use Pixel Helper for browser verification; if browser Test Events routing is required, design (not implement) an optional client-side test-code propagation with explicit production-off behaviour.

### F5 — Phone normalization is Indonesia-specific — LOW
- **File:** `lib/analytics/tiktok-user-match.ts` (`normalizeTikTokMatchPhone`, `DEFAULT_TIKTOK_MATCH_CALLING_CODE = "62"`).
- **Problem:** Non-Indonesian, non-`+`-prefixed numbers are dropped (return null).
- **Impact:** Phone matching omitted for non-ID formats; no wrong-guess hashing (this is deliberate and safer than guessing).
- **Recommendation:** Acceptable for an IDR-only store. Revisit only if international numbers are added.

### F6 — No `event_id` on non-CompletePayment events — INFO
- **File:** `lib/analytics/tiktok-pageview.ts`, `components/products/ProductDetail.tsx`, `app/checkout/CheckoutPage.tsx`.
- **Problem:** Only CompletePayment is deduplicated (browser↔server); other events are browser-only.
- **Impact:** None severe; those events have no server counterpart.
- **Recommendation:** No change.

## 16. Final Verdict

**SAFE TO TEST WITHOUT PAYMENT.**

Rationale: all identity hashing, payload construction, event_id generation, skip logic, security guards (token server-only, digest-only responses, PII-safe logs), and the CAS-authoritative CompletePayment trigger can be exercised through Level A automated tests, Level B local browser flows with a test account, and the Level C read-only/no-PII diagnostic probe — **without initiating any payment, changing any order state, or calling a production payment webhook**. The known findings are quality/behavioural (F2, F3) and informational (F1, F4, F5, F6), and none block safe, no-payment verification. F3 should be reviewed before relying on browser-side CompletePayment accuracy for non-COD orders.
