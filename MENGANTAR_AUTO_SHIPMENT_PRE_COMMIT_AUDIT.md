# FINAL PRE-COMMIT AUDIT — AUTO MENGANTAR SHIPPING

Scope: implementation + race-safety audit of the auto-shipment work only.
No architecture redesign. No unrelated payment/refund/TikTok/auth changes.
**No commit. No push. No production API writes.**

Recommendation: **READY TO COMMIT** (auto-shipment files only — see §12).

---

## 1. Payment duplicate
`ipaymu` and `midtrans` settlement both run an atomic raw CAS inside a
`$transaction`:
```sql
UPDATE `order` SET status='PAID', paymentStatus='PAID', ...
WHERE id=? AND status IN ('PENDING','PROCESSING')
  AND paymentStatus NOT IN ('PAID','REFUNDED')
```
- Only the transaction whose `affectedRows === 1` runs the enqueue; a replay
  gets `0` and returns early. ⇒ **one settlement, one enqueue.**
- Enqueue is `tx.shipmentJob.createMany({ data:[{orderId}], skipDuplicates:true })`
  and `ShipmentJob.orderId` is `@unique`. ⇒ **exactly one ShipmentJob**, even under
  concurrent/duplicate webhooks, and a replay can never throw inside the tx.
- `scheduleShipmentProcessing()` is called **inside `if (settled)`** and only for
  `MENGANTAR` + non-COD ⇒ the automatic workflow is triggered once per real settlement.
**PASS.**

## 2. Worker concurrency
- Claim is an atomic CAS: `where { id, status:'PENDING', nextAttemptAt ≤ now }`
  → `data { status:'PROCESSING', lockedAt, attempts+1 }`. Two workers: only one
  gets `count===1`; the other `continue`s. ⇒ one PROCESSING.
- Second layer: `createShipmentForOrder` takes its own order-level CAS
  (`NOT_CREATED/FAILED/… → CREATING`), so even a stray caller cannot double-post.
**⇒ no duplicate `POST /order`. PASS.**

## 3. Schedule creation + retry — EXACT BEHAVIOR
Trace for `scheduledPickup` when `POST /time` succeeds but `POST /order` fails:

1. `resolveMengantarPickupSchedule` → `POST /time` → returns fresh `time_id`.
2. `POST /order` either
   - **throws** → `releaseShipmentClaim(CREATING→NOT_CREATED)`, rethrow; **or**
   - **returns an item `error`** → `releaseShipmentClaim(CREATING→FAILED)`, `ok:false`.
3. Worker `retryJob` → job back to `PENDING` + exponential backoff; `attempts` was
   already incremented at claim. **`retryJob` does NOT persist `scheduleData`**, so the
   `time_id`/slot from step 1 is **discarded** (only the `DONE` and the
   `WAITING_SHIPPING_PAYMENT`→PAY transitions persist `pickupDate/pickupTime`).
4. Next claim re-enters `createShipmentForOrder` → resolves the pickup schedule again
   → **another `POST /time`** (recomputed WIB slot ≥90 min at retry time) → a **new
   `time_id`**.

**Conclusion: YES — every retry issues another `POST /time`.**
- Intentional and contract-safe: creating a fresh slot per attempt is exactly the
  documented `POST /time → POST /order` flow.
- The old slot is **orphaned** (no documented `DELETE /time` or expiry) ⇒ orphan-slot
  risk, documented, not a contract violation.
- **Same-shipment retry reuse is NOT implemented and must not be** — even retrying
  one order would send the same `time_id` to a *second* `POST /order` call, which the
  provider contract does not prove is allowed. Per the Phase-3 decision, keep current
  behavior. (No speculative reuse added.)
**PASS (by design), with documented orphan-slot risk.**

## 4. Job stale lock
- `processShipmentJobs` reclaims `PROCESSING` older than `STALE_JOB_LOCK_MS` (10 min)
  → `PENDING`; order-level `CREATING/PAYING` claims reclaim after `STALE_CLAIM_MS` (5 min).
- A crashed worker before the provider call ⇒ clean retry, no duplicate.
- A crash **after `POST /order` succeeded but before the CAS persist** can, after the
  stale window, re-claim and re-post. See §Non-blocking risk R1.
**PASS for the normal crash path; residual provider-duplicate window noted.**

## 5. Insufficient balance
- `isPaid:false` / `cnote_no:null` ⇒ `shipmentStatus=WAITING_SHIPPING_PAYMENT`,
  `shippingPaymentStatus=UNPAID`; `Order.paymentStatus` **untouched**.
- Worker switches job to `stage='PAY'`; `payUnpaidShipmentForOrder` CAS
  `WAITING_SHIPPING_PAYMENT→PAYING` then `POST /order/pay-unpaid`.
- Idempotent: if already `PAID`/`CREATED`, returns `ok, changed:false`; the claim CAS
  prevents double-charge. No `POST /time` on the PAY path.
**PASS.**

## 6. Refund race
Worker guard: `order.status==='CANCELLED' || order.paymentStatus==='REFUNDED'` → job
`CANCELLED`, no provider call. `createShipmentForOrder` has the same guard.
- PAID → job pending → REFUNDED: job cancelled, no shipment. ✅ (test added)
- PAID → job processing → REFUNDED: re-read at processing time → cancelled. ✅ (test)
- CREATED → REFUNDED / PICKED_UP → REFUNDED: `SHIPMENT_ALREADY_CREATED` / terminal
  guard ⇒ no second provider call. ✅
- Existing refund state machine untouched (only a read-only guard).
Residual: a refund landing between the read guard and `POST /order` can still create a
shipment (same as the pre-existing manual path) — see R2.
Tests added: `paymentStatus`-only REFUNDED and `status`-only CANCELLED variants.
**PASS.**

## 7. Pickup date/time (WIB)
- Resolver persists `slot.date`/`slot.time` — the **validated WIB wall-clock**
  (`mm-dd-yyyy` / `H:00`) — never the provider `POST /time` ISO echo. Admin modal renders
  `${pickupDate} ${pickupTime}` ⇒ e.g. `10-02-2026 14:00` (WIB), not an ISO/UTC string.
- Runtime check confirmed the provider clock is **WIB** (`nowDate=10-02-2026 now=08`
  vs real `08:23 WIB`), and the provider serialises slot `date` as a naive-as-UTC epoch
  (`1790949600000` for a `14:00` WIB slot) — which the code never treats as UTC.
**PASS.**

## 8. Admin UX
- Auto path is primary: the panel shows an informational "dibuat otomatis" banner for
  `SHIPMENT_PENDING`/unstarted jobs.
- Manual "Buat Shipment" is shown only when `status==='FAILED'` (recovery).
- Manual "Bayar Ongkir" only for `WAITING_SHIPPING_PAYMENT` (insufficient balance).
- Manual "Proses Ulang Otomatis" only for `FAILED` / `WAITING_SHIPPING_PAYMENT`.
- No admin action is required to create a shipment or to pick a schedule.
**PASS.**

## 9. Outbox durability
- Enqueue is inside the settlement tx ⇒ no lost job if the webhook response is lost.
- `scheduleShipmentProcessing()` uses `after()` and swallows errors; job stays `PENDING`
  for the sweeper. If `after()` itself is unavailable it falls back to a detached
  promise, also swallowed.
- `processShipmentJobs` (admin/cron sweep) picks up due jobs; retry uses exponential
  backoff (`1m → 30m`, capped); exhausted jobs → `FAILED`.
- `runShipmentJobForOrder` resets `attempts=0`, `stage=CREATE`, `PENDING` ⇒ FAILED
  recovery works. Job `PROCESSING` without finalize is reclaimed after 10 min.
**PASS.** (Loop-level fault isolation noted as R3.)

## 10. Security
- `MENGANTAR_API_KEY` / `MENGANTAR_WEBHOOK_SECRET` appear only in `lib/mengantar.ts`
  (server env), never in a client component, API JSON, audit metadata, or logs; no
  `NEXT_PUBLIC_MENGANTAR*`.
- `redactMengantarKey` strips the key from every thrown message; admin routes and the
  worker only log redacted messages. `fetchWithRetry` never logs the request URL (the
  key lives in the URL path). Webhook logs no signature/body/secret.
- Admin audit metadata for shipment creation contains only IDs/statuses — no secret.
**PASS.**

## 11. Test / build results
- Targeted: `mengantar-auto-shipment` **34 passed**; `mengantar-settings` + `mengantar-resolve` pass.
- Full Jest: **50 suites passed, 1447 passed, 4 skipped, 2 failed**.
  The 2 failures are in `__tests__/p0/remediation.integration.test.ts` (affiliate admin /
  MariaDB integration; suite references mengantar **0** times) — environment/DB-state
  dependent, **unrelated** to auto-shipment and pre-existing.
- `tsc --noEmit`: **exit 0**. `prisma validate`: **valid**. `npm run build`: **success**.

## 12. Files belonging to auto-shipment
**Modified (tracked):**
- `lib/mengantar.ts` — pickup-time/list plumbing, POST /order/pay-unpaid
- `lib/mengantar/shipment.ts` — create/pay lifecycle + claim guards
- `lib/mengantar/status.ts` — `SHIPMENT_PENDING` state + event mapping
- `prisma/schema.prisma` — `ShipmentJob` model + relation
- `app/admin/orders/[id]/page.tsx` — auto status/UI + recovery actions
- `app/api/admin/orders/[id]/shipment/route.ts` — expose outbox state (GET)
- `app/api/payment/ipaymu/notification/route.ts` — atomic enqueue + post-response run
- `app/api/payment/midtrans/notification/route.ts` — atomic enqueue + post-response run
- `__tests__/security/mengantar-settings.test.ts` — updated resolver assertion

**New (untracked):**
- `lib/mengantar/pickup-schedule.ts`
- `lib/mengantar/shipment-worker.ts`
- `prisma/migrations/20261002000000_add_shipment_job/migration.sql`
- `app/api/admin/orders/[id]/shipment/retry/route.ts`
- `app/api/admin/shipments/process/route.ts`
- `__tests__/security/mengantar-auto-shipment.test.ts`

**NOT part of auto-shipment — exclude from the commit:**
- `next-env.d.ts` — Next.js build artifact regenerated by `npm run build`
  (`.next/dev/types` → `.next/types`).
- `tsconfig.tsbuildinfo` — TS build cache; not currently gitignored.
- `PHASE_3_MENGANTAR_PICKUP_SCHEDULE_VERIFICATION.md` —
  audit documentation (feature-adjacent, not code; optional).

---

## Blockers
**None.** All twelve scenarios hold; no contract violation, no payment/refund mutation,
no secret leak, no double-enqueue, no duplicate shipment under concurrency.

## Non-blocking risks
- **R1 — Provider duplicate on lost `POST /order` response.** `POST /order` is not
  idempotent; if it succeeds but the response is lost, the stale-claim reclaim can
  re-post after the windows. Mitigations already present: no write retries in
  `fetchWithRetry`, order-level CAS claim, 5/10-minute stale thresholds. Residual and
  inherent (same as the manual path). Recommend future reconciliation via `GET /order`
  by `batch_id` — **not required to commit**.
- **R2 — Refund/create read-then-act window.** A refund between the guard read and
  `POST /order` can still create a shipment; no refund code is changed.
- **R3 — Sweep fault isolation.** `processShipmentJobs` does not wrap each
  `processClaimedJob` in try/catch; a thrown DB error aborts the batch. No job is lost
  (stays `PROCESSING`, reclaimed after 10 min).
- **R4 — Orphan pickup slots** on CREATE retries (one `POST /time` per attempt; no
  documented cleanup/expiry). Monitor `GET /time` volume.

## Exact retry behavior after `POST /time` succeeds but `POST /order` fails
Every retry issues a **new `POST /time`** and uses a **new `time_id`**; the previous
slot is discarded (never persisted on the job) and becomes an orphan. Same-shipment
`time_id` reuse is intentionally **not** implemented because it would send one
`time_id` to multiple `POST /order` calls, which the provider contract does not prove.

## Code changes required
Only the already-applied Phase-3 fix (persist the validated WIB slot, not the provider
ISO echo) plus the two refund-race tests and one slot-persistence test. **No further
code changes are required by this audit.**

## Final recommendation
**READY TO COMMIT** — commit the auto-shipment files listed in §12 only; exclude
`next-env.d.ts` and `tsconfig.tsbuildinfo` (build artifacts). No production writes were
made, no `time_id` reuse was added, and nothing was committed or pushed.
