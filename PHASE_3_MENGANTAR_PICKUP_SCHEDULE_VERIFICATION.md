# PHASE 3 — MENGANTAR PICKUP SCHEDULE CONTRACT VERIFICATION

Status: **DECISION PRODUCED — no commit / no push** (per instruction).
Scope: `lib/mengantar/pickup-schedule.ts`, `lib/mengantar/shipment-worker.ts`,
`lib/mengantar/shipment.ts`, `lib/mengantar.ts`, `ShipmentJob` schema + migration.
Nothing in payment / refund / TikTok / auth was touched.

---

## 1. Official documentation evidence

Source: <https://api-public.mengantar.com/docs/> (live, fetched 2026-10-02).

### `POST /time` — "Add Time"
- Body: `address_id`, `date` (`mm-dd-yyyy`), `time` (`9:00 … 18:00`).
- Documented response (HTTP 200):
  ```json
  { "success": true, "data": {
      "isSunday": false, "status": "empty",
      "_id": "6981621996f8fc74a332cf38",
      "date": "2026-02-03T00:00:00.000Z",
      "time": "13:00",
      "address": { "_id": "62e27d67ecf5ae2893bc070a", "...": "..." } } }
  ```
  Note: `date` is an **ISO datetime**, not `mm-dd-yyyy`; `status` is present.
- Explicit note: *"The pickup schedule (date + time) must be at least 90 minutes
  from the current time. A request with a pickup time less than 90 minutes ahead
  will return an invalid pickup time error."*
- **No documentation of:** idempotency, reuse, expiry, duplicate schedules,
  cleanup, or rate limits for `POST /time`.

### `GET /time` — "Get Time"
- Documented as `GET /api/public/{API_KEY}/time` (**no `address` query param documented**).
- Response items: `{ "_id", "date": <epoch ms>, "time": "HH:MM" }` (epoch, not ISO —
  inconsistent with `POST /time`).

### `POST /order` — "Create order"
- `pickup.type`: `scheduledPickup | dropOff`; `pickup.time_id` is *"required for type
  'scheduledPickup'"*; `pickup.volume` required for `scheduledPickup`.
- `pickup` is a **single batch-level object**; `orders` is an array. Therefore one
  `time_id` legitimately serves **every item in the same request** (batch-internal
  sharing is documented behaviour).
- **No documentation that `POST /order` consumes/locks `time_id`, and no documented
  error for re-using a `time_id` across separate requests.**

### `POST /order/pay-unpaid`
- Pays an already-created batch by `batch_id`; returns `data` (count) + `cnote_no[]`.
- No interaction with pickup schedules.

### Sandbox
- *"the sandbox API key is not available to all users — request one from the
  Mengantar Marketing & Operations team."*

---

## 2. Runtime evidence (READ-ONLY ONLY)

Environment: `.env` contains **only `MENGANTAR_API_KEY`**; `MENGANTAR_BASE_URL`
resolves to **production** (`https://api-public.mengantar.com`). No sandbox key is
configured. Per the instruction, **only read-only `GET` verification was performed.
No `POST /order`, no `POST /order/pay-unpaid`, no `POST /time`.**

| Call | Result |
|---|---|
| `GET /address` | exactly one pickup address: `_id=696f000072b771c089b488c0` ("Mutiara Abadi Snack"); also `nowDate=10-02-2026`, `now=08` |
| `GET /time` | `data=[{ "_id":"6abe22fced8de73f07aaeb16", "date":1790949600000, "time":"14:00" }]` |
| `GET /time?address=696f000072b771c089b488c0` | **identical** single slot (address param accepted; same result) |

Existing-evidence cross-check: the observed slot `6abe22fced8de73f07aaeb16`
`14:00` matches the pre-existing production evidence exactly, and is still listed.

Clock / timezone finding:
- Real clock at verification: `2026-10-02T01:23Z` = `08:23 WIB`.
- Provider reported `now=08` on `nowDate=10-02-2026` ⇒ the provider clock is **WIB**.
- Provider slot epoch `1790949600000` = `2026-10-02T14:00:00Z` while `time="14:00"`,
  i.e. the provider serialises the **WIB wall-clock as if UTC** (a naive-local
  artefact). The intended slot is `2026-10-02 14:00 WIB`.
- Consequence: a future reuse resolver MUST NOT compare the provider `date` epoch
  against a true UTC `now`; the encodings are inconsistent between `POST /time`
  (ISO) and `GET /time` (naive-as-UTC epoch) and no timezone basis is documented.

Because no sandbox key is available, a controlled `POST /time` (duplicate / reuse)
test could **not** be performed. Cross-request `time_id` reuse therefore remains
**unverified at runtime**.

---

## 3. Exact answers to the audit questions

| # | Question | Answer |
|---|---|---|
| 1 | May `time_id` be used for more than one order? | **Within one `POST /order` batch: YES (documented).** Across separate `POST /order` calls: **UNKNOWN** (not documented). |
| 2 | Is `POST /time` reusable, or a one-time reservation? | **UNKNOWN** — not documented. |
| 3 | Does a schedule expire automatically? | **UNKNOWN** — no documented expiry. |
| 4 | Are duplicate schedules for the same address/date/time allowed? | **UNKNOWN** — not documented. |
| 5 | Does `POST /order` consume/lock `time_id`? | **Not documented → UNKNOWN.** |
| 6 | Does `POST /time` have an idempotency mechanism? | **Not documented → UNKNOWN.** |
| 7 | What is the actual `POST /time` response? | `{ _id, date: <ISO datetime>, time, status, isSunday, address }` (docs §1). |
| 8 | Response/error when a `time_id` is reused? | **Not documented → UNKNOWN.** |

**Exact answer: cross-request `time_id` reuse = UNKNOWN** (only batch-internal
reuse is documented). Reuse is therefore **not proven allowed**.

---

## 4. Decision

**Reuse contract: UNKNOWN ⇒ `REUSE_ALLOWED` is rejected.**
**Resolver policy: B — `PER_ORDER_REQUIRED`; current fresh `POST /time` behaviour remains.**

This is **B, not C**, because per-order creation is *not* unproven: it is exactly the
documented two-step flow (`POST /time` → `POST /order`), it is already exercised by the
existing manual create path, and it guarantees a slot the provider itself validates
(≥ 90 min). C ("do not deploy") is reserved for the case where *no* behaviour is
supported — that is not the case here.

Why a fresh slot per shipment is effectively *required* under the current contract:
1. Cross-request reuse is undocumented/unverified → must not be implemented.
2. No documented expiry / cleanup / idempotency / locking → a reused slot could be
   already-consumed or stale; there is no way to prove validity.
3. A freshly created slot is validated by the provider against the ≥ 90-minute rule,
   which is the only validity guarantee the contract offers.

### Recommended resolver behaviour (implemented policy)
- `dropOff`: no schedule, no network call.
- `scheduledPickup`: compute the next WIB slot ≥ 90 min ahead, `POST /time` once per
  shipment attempt (single-claim CAS still prevents concurrent duplicate creates), and
  persist the **validated WIB slot** (`mm-dd-yyyy` / `H:00`) — not the provider's ISO
  `date` echo (see §6).
- Do **not** list/reuse existing slots. Do **not** implement a reuse resolver without
  explicit Mengantar confirmation.

---

## 5. Operational implications of per-order schedules (step 8)

| Concern | Finding |
|---|---|
| Creation volume | One `POST /time` per shipment **CREATE attempt**. `maxAttempts = 6` ⇒ up to 6 orphaned slots per order if `POST /order` keeps failing. |
| Duplicate schedules | Undocumented. Cannot confirm whether the provider dedupes address/date/time. |
| Schedule limits | No per-account schedule cap documented. |
| Cleanup / expiry | **No `DELETE /time` (or expiry) is documented** ⇒ orphan slots likely accumulate. |
| Rate limits | No `POST /time` rate limit documented (only label-print and JT/SiCepat batch-concurrency limits are documented). |
| Official support for 1 schedule/order | Yes — it is the documented flow. |

Residual risk is operational (orphan-slot accumulation), not a contract violation.

---

## 6. Files changed

- `lib/mengantar/pickup-schedule.ts`
  - Header comment updated with the Phase 3 contract-audit findings.
  - Resolver now persists the **validated** `slot.date` / `slot.time` (WIB,
    `mm-dd-yyyy` / `H:00`) instead of the provider's echoed `created.date`, which the
    official `POST /time` response proves is an **ISO datetime** and would have
    corrupted `ShipmentJob.pickupDate` and the admin "Jadwal pickup" display.
  - No change to reuse policy (still fresh-per-shipment), no change to lead-time,
    timezone math, CAS guards, or payment code.
- `PHASE_3_MENGANTAR_PICKUP_SCHEDULE_VERIFICATION.md` (this report).
- `ShipmentJob` schema/migration: **reviewed, unchanged** (analysis only).

No commit, no push. Working tree left uncommitted.

---

## 7. Tests & verification

- Targeted Jest: `mengantar-auto-shipment`, `mengantar-settings`,
  `mengantar-resolve` → **3 suites / 107 tests passed**.
- `tsc --noEmit` → **exit 0**.
- `prisma validate` → **"The schema at prisma/schema.prisma is valid"**.
- `npm run build` → **success**.
- No new tests added: the contract gained no *new proven reuse behaviour*, so a
  reuse test would assert unproven behaviour. The existing source-guarantee test
  ("creates a FRESH slot per shipment — never reuses a time_id") still passes.

---

## 8. Production safety conclusion

- **No production mutation was performed** — only read-only `GET /address` and
  `GET /time` (production key). No customer order was used, no `POST /order`, no
  `POST /pay-unpaid`, no `POST /time`.
- **Reuse was not implemented** — it remains UNKNOWN and unproven.
- The shipped/local behaviour stays on the documented per-order path, which is safe
  to deploy; the only residual risk is orphan-slot accumulation from failed create
  attempts (operational, monitorable via `GET /time`).
- **Do not deploy any reuse-based optimisation** until Mengantar confirms, in
  writing, that a `time_id` may be reused across separate orders and whether/ when
  it expires.
- Implementation remains **uncommitted / unpushed**, as instructed.
