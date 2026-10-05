# TikTok Matching Live Test — No Payment

**Date:** 2026-10-05
**Mode:** safe live attempt / no payment / no order mutation / no code change
**Result:** `TEST BLOCKED` (see §10)

---

## 1. Test Environment

| Item | Observed |
|---|---|
| Session host | `webdev` (generic dev host — **not** the production VPS) |
| Env files loaded (names only) | `.env.local`, `.env` |
| `TIKTOK_TEST_EVENT_CODE` visible to this process | **NO** (`not set / unusable`) |
| StoreSetting read | ok |
| `tiktokPixelEnabled` | yes |
| Pixel ID | present (public — `DA2N6IBC77U575JEFETG`) |
| TikTok Access Token (StoreSetting) | **MISSING** |
| Sender verdict (existing read-only diagnostic) | **would SKIP** — `missing_access_token` |
| Payment used | NO |
| Database mutation | NONE |
| Production webhook used | NOT USED |

Command used (existing tooling, no code change, read-only without `--send`):

```
npm run audit:tiktok   # scripts/tiktok-events-api-check.ts
```

This environment is **not the VPS**. The facts you provided (test event code present, previous probe HTTP 200 / code 0) do not match this host: here the test event code is absent **and** the Access Token is missing from StoreSetting. Per your rules I did **not** copy production `.env`/credentials, did not print any secret, and did not modify `.env`.

## 2. Test User

Read-only aggregate query against the **local** database (no PII printed):

```
RESULT {"totalUsers":194,"emailPresent":194,"phonePresent":174,"bothPresent":174}
```

- authenticated: NOT EXERCISED (no browser session / credentials available here)
- email present: YES (all 194 local users have email)
- phone present: YES for 174 of them
- external_id present: YES (`User.id` always exists)
- raw PII printed: **NO**

Caveat: these are **local** DB users. They cannot be assumed to be the VPS production accounts, and no test-user credentials were supplied, so the authenticated browser flow could not be exercised.

## 3. Email Matching Preparation (offline)

- normalization (`normalizeTikTokMatchEmail`: trim + lowercase + validation): **PASS**
- SHA-256 (`sha256TikTokMatch`): **PASS**
- digest format (64 lowercase hex): **PASS**

Evidence: existing suite `__tests__/security/tiktok-advanced-matching.test.ts` → `✓ normalizes exactly like TikTok: trim + lowercase`, `✓ hashes the normalized email with SHA-256`, `✓ is deterministic across calls`, `✓ omits unusable values instead of hashing them`. Empty digest output was **not** printed.

## 4. Phone Matching Preparation (offline)

- E.164 normalization (`normalizeTikTokMatchPhone`, `+62…`): **PASS**
- SHA-256: **PASS**
- digest format (64 lowercase hex): **PASS**

Evidence: same suite → `✓ converts local Indonesian formats to E.164`, `✓ keeps the leading plus in the hashed value (TikTok rule)`, `✓ keeps an already-international non-62 number`, `✓ drops numbers it cannot place in a country`.

## 5. Payload

- CompletePayment: intended YES (probe) — **not built/sent live**
- synthetic reference (`TIKTOK-MATCH-DIAGNOSTIC-<ts>-<nonce>`): planned, not sent
- production order: NO
- payment reference / trx id: NO
- email hash: PRESENT capability (proven offline)
- phone hash: PRESENT capability (proven offline)
- external_id hash: PRESENT capability (proven offline)

Offline proof that the **authoritative** builder attaches hashed keys: `✓ CompletePayment sends hashed email/phone/external_id`, `✓ no raw PII, no token, in the request body`.

## 6. TikTok API

- HTTP status: **N/A — request not sent**
- TikTok code: N/A
- message: N/A
- accepted: N/A
- request_id: N/A
- test_event_code attached: **NO (not available in this environment)**

## 7. TikTok Test Events

- event visible: **NOT CHECKED** (no send, no Events Manager access)
- event accepted: NOT CHECKED
- email identifier visible/accepted: **NOT EXPOSED / NOT CHECKED**
- phone identifier visible/accepted: **NOT EXPOSED / NOT CHECKED**
- external_id visible/accepted: **NOT EXPOSED / NOT CHECKED**

## 8. Browser Verification

- `GET /api/analytics/tiktok-match` anonymous → `{ success:true, data:{} }`: verified by existing suite (`✓ anonymous visitors get nothing and no lookup`)
- authenticated → digest-only `{email, phone_number, external_id}`: verified by existing suite (`✓ returns ... SHA-256 DIGESTS only`, each asserted `/^[a-f0-9]{64}$/`)
- raw PII absent from response: verified (`✓ no raw PII anywhere in the response`)
- `ttq.identify()` receives digests: verified by suite (`✓ the client component consumes the endpoint payload and never hashes locally`, `✓ the event storefront callers never call ttq.identify directly`)
- AddToCart / InitiateCheckout gating on identity: verified (`✓ TEST — AddToCart waits for matching data before firing`, `✓ TEST — InitiateCheckout waits for matching data before firing`)
- live browser session: **NOT PERFORMED** (no test-user credentials supplied)

## 9. Payment Safety

- payment invoked: **NO**
- payment webhook invoked: **NO**
- order marked PAID: **NO**
- DB mutation: **NO** (all accesses were read-only; the diagnostic was run without `--send`)
- shipment created: **NO**
- fake CompletePayment sent: **NO**

## 10. Final Verdict

**TEST BLOCKED**

### Exact blockers (no improvisation)

1. **Wrong environment.** This session runs on a dev host (`webdev`); `TIKTOK_TEST_EVENT_CODE` is absent and the TikTok Access Token is missing from StoreSetting. The server sender therefore skips, and no Test Event can be routed. Copying production env/credentials is forbidden by your rules, so this cannot be fixed from here.
2. **No existing safe matching sender.** The only Events API probe (`scripts/tiktok-events-api-check.ts`) intentionally sends **no** user identifiers. The hashing helper `lib/analytics/tiktok-user-match.ts` is `server-only` and cannot be imported by a standalone Node/tsx script (`server-only` is Next-resolved and not installed in `node_modules`). Sending an event **with** matching keys would require new code (a script or endpoint) — explicitly forbidden.
3. **No authenticated test user available.** No credentials/session were supplied, so the live browser flow and a real-user digest check could not be performed. Creating a production user is forbidden.

### What IS proven without payment
The **current production implementation** already builds and would send valid `user.email` + `user.phone` + `user.external_id` as SHA-256 digests on `CompletePayment` — proven offline by the existing suites (11 suites / 325 tests pass), including the authoritative server builder and the browser endpoint. The email/phone matching pipeline is correct by code and test.

### What is NOT proven
That TikTok Events Manager **visually confirms** the matching identifiers on a live Test Event. That step requires executing on the VPS with the test event code, and it requires a matching-key probe sender that does not exist yet (must not be added during this audit).

### Minimal safe path to finish (recommendation only — not implemented)
- Run the existing read-only diagnostic on the VPS: `npm run audit:tiktok`.
- To prove matching end-to-end, an operator would need a sender that attaches `buildTikTokUserMatch(...)` output to a synthetic probe with `test_event_code`. Because that helper is `server-only`, the clean options are (a) a server-side route/runner inside the Next runtime, or (b) a deliberately non-`server-only` pure hashing module re-exported for tooling. **Neither was implemented**, per the no-code-change rule.
