# TikTok Diagnostic Fix — Email / Phone Matching-Key Coverage

Status: **implemented + verified, NOT committed** (per instruction).
Scope: real matching-key coverage for authenticated/customer events. No fake
data, no diagnostic gaming, no event suppression, catalog untouched.

> **Revision note (this pass).** Sections 1, 8, 9, 13, 14, 19, 24 below were
> corrected after two findings that the first pass got wrong:
> 1. **The browser channel was sending RAW values while the server sent SHA-256
>    digests.** The previous report claimed the Pixel auto-hashes raw input, so
>    raw was "correct" — true for email/phone, but it meant raw PII crossed the
>    network, and `external_id` was sent raw by the browser while the server
>    hashed it, so the two channels could **never** match. Both channels now send
>    digests.
> 2. **The readiness race was real but was not the whole story.** Three further
>    defects are documented in (1) and are now fixed.

---

## 1. Root cause of the TikTok diagnostic

Four distinct defects, not one.

### 1a. `external_id` could never match across channels (primary)

The server Events API channel hashes `external_id` (per TikTok's Business API
v1.3 spec). The browser channel sent `external_id` **raw**, and TikTok's Pixel
does **not** hash `external_id` (see 13). So the browser reported
`user_abc123` while the server reported
`sha256("user_abc123")` — two different user IDs for the same person. Every
event in the browser channel was therefore unmatched on the strongest key,
and the browser/server pair could not be stitched together.

### 1b. Raw PII crossed the network to the browser

The endpoint returned normalized **raw** email/phone, so raw PII was present in
a browser network response. Sending digests is both safer and required for
1a to work (see 13).

### 1c. A browser identity-readiness race (the original diagnosis — still real)

`components/analytics/TikTokAdvancedMatching.tsx` settled the shared identity
store as *anonymous* from inside `apply()` whenever `identifiersRef.current`
was still `null`:

```js
const apply = () => {
    const identifiers = identifiersRef.current;
    if (appliedRef.current) return;
    if (!identifiers) {
        settleTikTokIdentity(null);   // ← released as anonymous
        return;
    }
    ...
};
...
const cancel = whenTikTokPixelReady(apply);          // path A: Pixel ready
loadBrowserMatch().then((data) => { ...; apply(); }); // path B: lookup ready
```

The base code is loaded with `strategy="afterInteractive"`, so `window.ttq`
normally exists within milliseconds, while `/api/analytics/tiktok-match` is a
network round-trip. **Path A therefore wins almost every time**, `apply()` sees
`null`, and the store is permanently released as anonymous
(`settleTikTokIdentity` is idempotent — first settlement wins). Every event
that was waiting on the store fired with **no email/phone**, even though the
identify call was applied a moment later.

### 1d. A one-shot readiness callback could lose the identifiers outright

`whenTikTokPixelReady` invokes its callback **at most once**, and
`isTikTokPixelReady()` is just `Boolean(window.ttq)`. That is true as soon as
the base code creates the `ttq` array — one tick *before* the Pixel's deferred
`identify` method is attached. If the callback ran in that window,
`ttq.identify` did not exist, the call silently failed, and the visitor stayed
unidentified for the rest of the page load with no retry.

### 1e. A login mid-session could never upgrade the identity

`settleTikTokIdentity` is a one-shot settlement, correct for the common case. A
visitor who logged in without a full page load had already been recorded as
anonymous, and the real identifiers that arrived afterwards had nowhere to go,
so events in that window fired unmatched.

### 1f. TikTok's own base-code `PageView` always fires before `identify`

The configured base code is `ttq.load()` → `ttq.page()` with no
`handl_advanced_matching`, and `ttq.page()` is queued synchronously at load
time. It cannot be deferred, so PageView stays unmatched for everyone
(including authenticated users) and should be expected in the diagnostic.

## 2. Which events lacked matching keys

| Event | Channel | Keys before |
| --- | --- | --- |
| PageView | browser (base code) | none (fires before identify — 1f) |
| ViewContent | browser | none when Pixel won the race (1c) |
| AddToCart | browser | none when Pixel won the race (1c) |
| InitiateCheckout | browser | none when Pixel won the race (1c) |
| AddPaymentInfo | browser | none when Pixel won the race (1c) |
| CompletePayment | browser | none when Pixel won the race (1c) |
| CompletePayment | server | already had hashed email/phone/external_id |

## 3. Why they lacked them

Authentication resolved correctly and the endpoint returned valid identifiers.
The failures were **ordering** (1c/1d/1e) and **channel disagreement on the
digest bytes** (1a/1b) — not missing data.

## 4. Exact fix

Module `lib/analytics/tiktok-browser-identity.ts` owns the lifecycle with
module-level state:

- the store is released as anonymous **only after the lookup has resolved with
  nothing usable** (`matchResolved && !matchIdentifiers`);
- while the lookup is in flight, `applyTikTokBrowserIdentity()` does nothing —
  no settlement — so no event can beat its own matching data;
- once identifiers exist, it waits for the Pixel (`whenTikTokPixelReady`),
  calls `trackTikTokUserMatch()` (identify), and only then
  `settleTikTokIdentity(identifiers)`;
- idempotent + independent of React lifecycle (StrictMode double-mount and SPA
  re-mount safe);
- bounded by `TIKTOK_BROWSER_MATCH_TIMEOUT_MS = 2500` so a hanging endpoint
  resolves to "anonymous" instead of stalling events.

`TikTokAdvancedMatching.tsx` is now a thin eligibility wrapper: it only decides
*authenticated / non-admin / pixel-enabled*, calls
`bootstrapTikTokBrowserIdentity()` for eligible visitors, and settles anonymous
for everyone else.

## 5. Browser matching flow — before

```
Pixel ready ──► apply() (identifiers still null) ──► settle(ANONYMOUS)
                                                        │
        ViewContent / AddToCart / … fire with NO keys ◄─┘
        (identify applied too late to matter)
```

## 6. Browser matching flow — after

```
Pixel ready ─┐
             ├─► (store stays PENDING while lookup in flight)
lookup ready ┘
       │
       ▼
attempt() → whenTikTokPixelReady → ttq.identify(SHA-256 digests)
       │                            │
       │                            └─► if ttq.identify is not
       │                                attached yet: bounded retry
       │                                (8 × 300 ms) instead of
       │                                silently losing the keys
       ▼
upgradeTikTokIdentity(digests)   (anonymous → identified, never downgraded)
settleTikTokIdentity(digests)
       │
       ▼
eligible events fire WITH matching keys
```

## 7. Server matching flow

Unchanged (Phase 22): settlement webhook → `trackTikTokServerCompletePayment`
→ `buildTikTokUserMatch` (SHA-256) → `data[].user`. Only CompletePayment is
sent server-side; no extra server events were added merely to raise coverage.

## 8. Email normalization

`trim → lowercase → shape check (/^[^\s@]+@[^\s@]+\.[^\s@]+$/) → max 254`.
The browser and the server both receive/send `SHA-256(normalized)` — no raw
value crosses the network. Invalid/empty/null/too-long → key omitted (never an
empty-string hash).

## 9. Phone normalization

`E.164` → `+<country code><number>`, default calling code `62`.
Accepts `08…`, `8…`, `62…`, `+62…`; strips spaces/hyphens; drops the national
trunk `0`; min 8 / max 15 digits. Unplaceable numbers are **omitted**, never
guessed. Both channels send `SHA-256("+62…")`; the browser's field is named
`phone_number`, the server's `phone` (each channel's documented name).

## 10. Events now carrying email (authenticated customer with email)

ViewContent, AddToCart, InitiateCheckout, AddPaymentInfo, browser
CompletePayment (all via `whenTikTokReadyForEvents`), plus server
CompletePayment.

## 11. Events now carrying phone (when the user has a phone)

Same set as (10). If the user has only email or only phone, only that key is
sent (tests 9/10).

## 12. Anonymous-event behavior

Anonymous / disabled / admin visitors: the store settles `null` **immediately**
and no lookup request is made. ViewContent and AddToCart still fire normally,
with no fabricated keys. An lookup that fails (HTTP 500 / timeout) also
resolves to anonymous so events are never blocked.

## 13. Is `ttq.identify` sufficient per current TikTok docs?

**Yes**, and the exact digest contract was verified against TikTok's own
shipped pixel source rather than assumed.

Docs:
- Advanced Matching for Web (updated Sept 2025) — customer email/phone are
  hashed with SHA-256 "before reaching TikTok servers".
- Manual Advanced Matching (updated Feb 2025) — registers identifiers via code.
- Business API v1.3 — Events API `user_data` requires SHA-256 for
  `email` / `phone` / `external_id`.

Source of truth — TikTok's own pixel bundle (`events.js`, `main.MWU2MzIzODM0MA.js`),
Identify plugin `baseHandleUserProperties`:

```js
email:  isHash(v) ? v : sha256(handleEmail(v))
phone:  isHash(v) ? v : sha256(handlePhoneNumber(v))
external_id: (passed through UNCHANGED — not hashed)
```

Two consequences, and the previous report got the first one wrong:

1. **A digest is accepted as-is — it is NOT double-hashed.** So the browser can
   safely receive a pre-computed digest. The old "raw is the only correct
   browser input" conclusion was incorrect; it happened to still work for
   email/phone because the Pixel hashed it client-side, but it shipped raw PII
   over the network for no benefit.
2. **`external_id` is never hashed by the Pixel.** Therefore the browser must
   send a digest that equals the server's digest, or the two channels describe
   different users (defect 1a).

So both channels now send `SHA-256` digests, and `ttq.identify` applies them to
subsequent events exactly as the manual Advanced Matching flow prescribes.

## 14. Was there a timing/race?

**Yes** (1c, 1d, 1e) — but it was not the only defect, and fixing ordering
alone would still have left the two channels unable to match (1a). The fix uses
an explicit readiness mechanism: no arbitrary `setTimeout` delays for
ordering. The only timers are bounded fail-safes — a 2500 ms fetch timeout and
a bounded identify retry (8 × 300 ms) that gives up and lets the identity
timeout release events rather than stalling the page.

## 15. `ttp` / click ID changes

None. Phase 22 attribution is untouched; no new migration, no fabricated `ttp`.

## 16. Catalog implementation confirmed untouched

No changes to `content_id` / `contents` / `content_type` / `content_name` /
`price` / `quantity` / `value` / `currency` / catalog mapping. `lib/analytics/tiktok-catalog.ts`
was not modified; test 15 asserts `content_id` is still the product id.

## 17. Deduplication confirmed

`buildTikTokEventId("CompletePayment", order)` → `ttq:completepayment:<order>`,
identical in the browser Pixel and the server Events API. Test 16 asserts the
browser id equals the server `data[0].event_id`.

### Cross-channel digest equivalence (new, the decisive check)

TikTok stitches a browser event to a server event by the `user_data` digests it
received, so a one-byte disagreement destroys matching regardless of correct
ordering. A test now asserts the digests handed to `ttq.identify` equal the
digests the server channel sends, field for field:

```js
expect(identifiers).toEqual({
    email:        serverPayload.email,        // same digest
    phone_number: serverPayload.phone,        // same digest, browser's key name
    external_id:  serverPayload.external_id,  // same digest
});
```

## 18. Security scan

- `npx tsc --noEmit --incremental false` → clean
- `git diff --check` → clean (no whitespace errors)
- `.next/static` scan after a real `npm run build`:
  - `Access-Token` = 0, `business-api.tiktok.com` = 0, `accessToken` = 0
  - `TIKTOK_PIXEL_CODE` / `TIKTOK_ACCESS_TOKEN` / `TIKTOK_PIXEL_ID` = 0
  - test PII (`buyer@example.com`, `08123456789`, `628123456789`) = 0
  - server-only helpers (`buildTikTokBrowserMatch`, `buildTikTokUserMatch`,
    `createHash`) = 0 in client bundles
- The only `tiktokPixelAccessToken` occurrences are admin form **field names**
  plus the `Configured` boolean and `Last4` display — no token value.
- Server Events API request body carries SHA-256 digests only — no raw email
  or phone (test 6).
- The browser endpoint response is additionally filtered through a
  `digestOnly` guard, so even a future regression in the builder cannot
  serialize a raw value.
- `scripts/` scan: the only PII-looking hits are pre-existing iPaymu test
  fixtures, untouched by this change. The temporary DB-probe script
  (`scripts/_tmp-probe.ts`) was deleted after use.

## 19. Tests

- `__tests__/security/tiktok-matching-coverage.test.ts` — 28 tests covering
  the 16 required cases (ordering per event, anonymous tracking, partial /
  invalid identifiers, privacy, catalog, dedup) plus the new liveness and
  identity-upgrade cases:
  - the browser digests equal the server Events API digests (cross-channel)
  - a Pixel whose `identify` is not attached yet is retried
  - a visitor who logs in mid-session is upgraded from anonymous
  - identity can never be downgraded back to anonymous
- `__tests__/security/tiktok-attribution.test.ts` and
  `tiktok-advanced-matching.test.ts` updated to the digest contract.
- Source-scan assertions now strip comments before matching, so they inspect
  **code** rather than prose (a doc comment describing `ttq.identify(` is not
  an implementation of it).
- TikTok suites: **212 passed, 0 failed**.
- Full security folder: **458 passed, 4 skipped, 0 failed**.
- Full Jest: **1098 passed, 4 skipped, 2 failed** — both in the
  **pre-existing, environmental** `__tests__/p0/remediation.integration.test.ts`
  (live MariaDB transaction/concurrency timing). That file contains zero
  references to tiktok/analytics and fails identically in isolation, so it is
  unrelated to this change.
- Test-hygiene fix: tests now call the `cancel` function returned by
  `whenTikTokReadyForEvents`, removing 2 of 3 leaked timers. The one remaining
  open handle is a pre-existing module-level `setInterval` in
  `lib/rate-limit.ts:45` (no `unref`), outside this task's scope.

## 20. TypeScript

`npx tsc --noEmit --incremental false` → exit 0.

## 21. Prisma

`npx prisma validate` → valid. No schema or migration changes in this task.

## 22. Build

`npm run build` → succeeded.

This surfaced a **real build break** that `tsc` alone did not catch:
`lib/analytics/tiktok-browser-identity.ts` imported `isTikTokMatchDigest`
from the `server-only` module `tiktok-user-match.ts`, and the build fails with
`'server-only' cannot be imported from a Client Component module`. The
validator was moved to the shared, client-safe `lib/analytics/tiktok.ts` and
re-exported for the server, giving one definition that both sides use. The
full client-import graph now builds clean.

## 23. Runtime verification

Production build served on `:3002`:
- `/` → 200.
- `GET /api/analytics/tiktok-match` (anonymous) → `{"success":true,"data":{}}`
  with `cache-control: no-store`. Correct: anonymous gets nothing, no DB read.
- No secrets/PII in served HTML (see 18).

A **runtime smoke test** drove the real production modules end-to-end against
a mock Pixel and a mock endpoint with 60 ms of realistic latency, and asserted
the observable contract rather than assuming it:
- the eligible event stayed held while the lookup was pending;
- `ttq.identify` ran **before** the event, with all three values 64-hex;
- no raw email / phone / user id appeared in the identify payload;
- the identify digests equalled the server channel's digests field for field.

That last assertion is what surfaced the `phone` vs `phone_number` naming
difference, which is expected (each channel's documented name) and is now
asserted explicitly. The smoke file was temporary and has been deleted; its
assertions live on as permanent tests.

A full authenticated end-to-end browser run (login → product → checkout →
payment) against live data was **not** executed: it requires a real test user
and a safe payment path.

## 24. Exact files changed

- modified `lib/analytics/tiktok-user-match.ts` — `buildTikTokBrowserMatch`
  returns SHA-256 digests; digest validator re-exported from the shared module
- modified `app/api/analytics/tiktok-match/route.ts` — serializes digests only,
  behind a `digestOnly` guard
- modified `lib/analytics/tiktok.ts` — shared `isTikTokMatchDigest` /
  `TIKTOK_MATCH_SHA256_PATTERN`; `trackTikTokUserMatch` refuses non-digests
- modified `lib/analytics/tiktok-identity.ts` — `upgradeTikTokIdentity`
- modified `lib/analytics/tiktok-browser-identity.ts` — digest-only mapping,
  bounded identify retry, identity upgrade
- modified `components/analytics/TikTokAdvancedMatching.tsx` (documented the
  corrected digest contract; eligibility only)
- modified `components/analytics/AnalyticsProvider.tsx` (corrected a stale
  comment that claimed only digests reach Advanced Matching)
- modified `__tests__/security/tiktok-matching-coverage.test.ts`,
  `tiktok-attribution.test.ts`, `tiktok-advanced-matching.test.ts`
- modified this report

No payment state machine, checkout, catalog, or attribution file changed.

## 25. Unrelated Scan Resi changes confirmed untouched

`git status --short` lists only the 10 TikTok files in (24) plus this report.
`app/admin/scan-resi/page.tsx`, `app/globals.css`, `lib/resi-scan/pdf.ts`,
`next.config.ts`, `components/admin/scan-resi/` and
`__tests__/security/resi-scan-pdf.test.ts` were **not** read-modified,
reverted, or staged. No destructive git command was run. Nothing was committed
or pushed.

---

## Honest diagnostic expectation

This does **not** promise 0%. TikTok legitimately receives anonymous events:
- PageView for logged-out traffic, and
- the base-code `ttq.page()` for **everyone**, which is queued synchronously at
  Pixel load and structurally cannot precede `ttq.identify` (defect 1f). This
  is a floor on the diagnostic, not a bug in this codebase.

What is now guaranteed for an authenticated customer:
- no raw PII reaches the browser or the Pixel;
- the browser and server channels send **identical** digests, so the two can be
  stitched together;
- every eligible event is dispatched **after** the matching data is ready and
  **after** `ttq.identify` has actually succeeded (retried, not one-shot);
- a mid-session login upgrades the identity rather than being discarded;
- anonymous visitors still track, with no fabricated keys and no blocking.

Residual uncertainty: the exact share of the historical diagnostic attributable
to each defect cannot be recovered from the TikTok UI, and the previous report's
single-cause claim was not evidence-based. Expect a material improvement in
authenticated/customer coverage, not a specific percentage.
