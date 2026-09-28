# TikTok Diagnostic Fix — Email / Phone Matching-Key Coverage

Status: **implemented + verified, NOT committed** (per instruction).
Scope: real matching-key coverage for authenticated/customer events. No fake
data, no diagnostic gaming, no event suppression, catalog untouched.

---

## 1. Root cause of the TikTok diagnostic

A **browser identity-readiness race**, not a hashing problem.

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

A secondary contributor: TikTok's own base-code `PageView` always fires
before the asynchronous `ttq.identify()`, so PageView is unmatched for
everyone (including authenticated users).

## 2. Which events lacked matching keys

| Event | Channel | Keys before |
| --- | --- | --- |
| PageView | browser (base code) | none (fires before identify) |
| ViewContent | browser | none when Pixel won the race |
| AddToCart | browser | none when Pixel won the race |
| InitiateCheckout | browser | none when Pixel won the race |
| AddPaymentInfo | browser | none when Pixel won the race |
| CompletePayment | browser | none when Pixel won the race |
| CompletePayment | server | already had hashed email/phone/external_id |

## 3. Why they lacked them

Authentication resolved correctly and the endpoint returned valid identifiers;
the issue was purely **ordering**: the Pixel-ready path released the identity
store before the matching data existed, so events were allowed to fire early.

## 4. Exact fix

New module `lib/analytics/tiktok-browser-identity.ts` owns the lifecycle with
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
apply() → whenTikTokPixelReady → ttq.identify(raw keys)
       │
       ▼
settleTikTokIdentity(identifiers)
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
Browser receives the normalized RAW value; server receives `SHA-256(that)`.
Invalid/empty/null/too-long → key omitted (never an empty-string hash).

## 9. Phone normalization

`E.164` → `+<country code><number>`, default calling code `62`.
Accepts `08…`, `8…`, `62…`, `+62…`; strips spaces/hyphens; drops the national
trunk `0`; min 8 / max 15 digits. Unplaceable numbers are **omitted**, never
guessed. Server hashes `+62…`; browser receives `phone_number: "+62…"`.

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

Yes. TikTok "Advanced Matching for Web" (last updated Sept 2025): customer
emails/phone are hashed with SHA-256 "before reaching TikTok servers"; Manual
Advanced Matching registers identifiers per event via code. Independent SDK
documentation confirms the browser SDK accepts `email` / `phone_number` /
`external_id` and **auto-hashes (SHA256) before sending**. So the normalized
RAW value is the correct browser input; sending a pre-computed digest would be
double-hashed and match nobody. Events API is the opposite (SHA-256 required).

## 14. Was there a timing/race?

**Yes — it was the root cause**, and it is now fixed with an explicit readiness
mechanism (no arbitrary `setTimeout` delays; a bounded fetch timeout is the
only timer, as a fail-safe).

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

## 18. Security scan

- `npx tsc --noEmit --incremental false` → clean
- `.next/static` scan: `Access-Token` = 0, `business-api.tiktok.com` = 0,
  `accessToken` = 0. The only `tiktokPixelAccessToken` occurrences are admin
  form **field names** plus the `Configured` boolean and `Last4` display — no
  token value. `act.` hits are `react.*` RSC markers; the phone-regex hit is a
  big-integer constant; `email@toko.com` is an admin form placeholder.
- Served production HTML: no `Access-Token`, no `business-api.tiktok.com`, no
  `accessToken`; the only email is the store's public `mailto:` contact.
- Server Events API request body carries SHA-256 digests only — no raw email
  or phone (test 6).

## 19. Tests

- New `__tests__/security/tiktok-matching-coverage.test.ts` — 23 tests covering
  the 16 required cases (ordering per event, anonymous tracking, partial /
  invalid identifiers, privacy, catalog, dedup).
- TikTok suites: 205 passed, 0 failed.
- Full security folder: 452 passed, 4 skipped, 0 failed.
- Full Jest: 1091 passed, 4 skipped, 3 failed — all 3 in the **pre-existing,
  environmental** `__tests__/p0/remediation.integration.test.ts` (live MariaDB
  transaction/concurrency timing). Unrelated to this change.

## 20. TypeScript

`npx tsc --noEmit --incremental false` → exit 0.

## 21. Prisma

`npx prisma validate` → valid. No schema or migration changes in this task.

## 22. Build

`npm run build` → succeeded.

## 23. Runtime verification

Production build served on `:3002`:
- `/` → 200.
- `GET /api/analytics/tiktok-match` (anonymous) → `{"success":true,"data":{}}`
  with `cache-control: no-store`. Correct: anonymous gets nothing, no DB read.
- No secrets/PII in served HTML (see 18).

A full authenticated end-to-end browser run (login → product → checkout →
payment) was **not** executed: it requires a real test user and a safe payment
path, and would touch live data. The required ordering is instead proven by the
mocked-transport tests, which assert `identify` fires before each eligible
event and that the event is held while the lookup is pending.

## 24. Exact files changed

- **new** `lib/analytics/tiktok-browser-identity.ts`
- **new** `__tests__/security/tiktok-matching-coverage.test.ts`
- modified `components/analytics/TikTokAdvancedMatching.tsx` (delegates to the
  new bootstrap; eligibility only)
- modified `components/analytics/AnalyticsProvider.tsx` (corrected a stale
  comment that claimed only digests reach Advanced Matching)
- modified `__tests__/security/tiktok-advanced-matching.test.ts` (two
  source-scan assertions retargeted at the new module)

No payment state machine, checkout, catalog, or attribution file changed.

## 25. Unrelated Scan Resi changes confirmed untouched

The working tree was clean at the start of this task (Phase 22 already
committed). `git status --short` now lists only the five files in (24).
`app/admin/scan-resi/page.tsx`, `app/globals.css`, `lib/resi-scan/pdf.ts`,
`next.config.ts`, `components/admin/scan-resi/` and
`__tests__/security/resi-scan-pdf.test.ts` were **not** read-modified,
reverted, or staged. No destructive git command was run.

---

## Honest diagnostic expectation

This does **not** promise 0%. TikTok legitimately receives anonymous events
(PageView for logged-out traffic and the base-code PageView that precedes
`identify`). What is now guaranteed is that every eligible event of an
authenticated customer is dispatched **after** their matching data is ready, so
authenticated/customer coverage improves materially while anonymous events
remain valid anonymous events.
