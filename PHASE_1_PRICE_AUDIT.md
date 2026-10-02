# PHASE 1 — AUDIT HARGA NORMAL/CORET vs HARGA JUAL AKTUAL

Status: **AUDIT ONLY — no implementation, no code changed, no migration run, no commit.**
Scope of investigation: Prisma schema + every price code path (display, cart, checkout,
order, voucher, affiliate, refund, payment).

---

## A. Field harga yang ada sekarang

| Model | Field | Type | Meaning today |
| --- | --- | --- | --- |
| `Product` | — | — | **No price field.** |
| `ProductVariant` | `price` | `Decimal(12,2)` | **The single authoritative base/sell price.** |
| `CartItem` | — | — | No price stored; derived from the variant. |
| `OrderItem` | `price`, `subtotal` | `Decimal(12,2)` | Order-time **snapshot** of the effective (discounted) unit price. |
| `Order` | `subtotal`, `discount`, `total` | `Decimal(12,2)` | Order-time **snapshot** of money charged. |
| `FlashSale` | `salePrice` | `Decimal(12,2)` | Marketing flash-sale price (overrides variant price). |
| `AffiliateConversion` | `orderSubtotal`, `commissionRate`, `commissionAmount` | `Decimal` | Snapshot at order creation. |

There is already a marketing pricing layer that does **not** modify `variant.price`:
`ProductDiscount`, `FlashSale`, `BulkDiscount`, `CampaignProduct`, `Voucher`.
`lib/marketing/pricing.ts` / `batch-pricing.ts` return:
- `originalPrice` = raw `ProductVariant.price` (**marketing base**)
- `effectivePrice` / `finalPrice` = price after marketing discounts (what the customer pays)

> ⚠ **Naming collision (critical).** The codebase ALREADY uses `originalPrice` to mean
> "raw variant.price before *marketing* discount", and that value is already rendered as a
> strikethrough in product cards/cart. The requested "Harga Normal/coret" is a **different**
> concept and must NOT be named `originalPrice`. Recommended new field name: **`comparePrice`**
> (alt: `normalPrice`/`listPrice`).

## B. Authoritative price path (sell price)

All order creation funnels through **`createCheckoutOrder()`** — `lib/checkout.ts:792`
(called by `app/api/orders/route.ts`, `app/api/payment/ipaymu/route.ts`,
`app/api/buy-now/route.ts`, `app/api/buy-now/ipaymu/route.ts`; Midtrans does not create orders).

1. Input carries only `productId` / `variantId` / `quantity` (+ selections) — **no price**.
2. Items are re-loaded from DB (`tx.productVariant … variant.price`) for both `BUY_NOW`
   and `CART` modes (`lib/checkout.ts` ~1185, ~1340).
3. `resolveBatchMarketingPricing()` sets `item.price = effectivePrice`, `item.subtotal = effectivePrice × qty`.
4. `subtotal = Σ item.subtotal`.
5. Voucher: `validateAndCalculateVoucherEnhanced(code, subtotal, items(price=effective), …)`.
6. Spin-wheel discount; server-verified shipping.
7. `grossAmount = subtotal − discount − spinWheelDiscount + shippingCost`.
8. `tx.order.create({ subtotal, total: grossAmount, discount, items.create({ price: item.price, subtotal }) })`.
9. Affiliate: `calculateCommission(Number(subtotal), rate)` — based on effective subtotal.
10. Payment amount: order `total` / `item.price` snapshots (iPaymu direct, Midtrans itemDetails).

**Authoritative chain:** `ProductVariant.price` → marketing `effectivePrice` → `OrderItem.price` snapshot → `Order.total` → payment/refund/affiliate.

Security today is correct: client price is never read; cart stores only `variantId`+`quantity`,
so cart tampering cannot change any total.

## C. Semua tempat yang HARUS berubah (recommended additive design)

Recommended design (fail-safe, backward-compatible): keep `ProductVariant.price` as the
authoritative **sell price**, add a new nullable **display-only** `comparePrice` ("Harga Normal").
Existing products get `comparePrice = NULL` → no strikethrough → behaviour identical.

| # | File | Change |
| --- | --- | --- |
| 1 | `prisma/schema.prisma` | `ProductVariant.comparePrice Decimal? @db.Decimal(12,2)` |
| 2 | `prisma/migrations/<new>/migration.sql` | Additive `ALTER TABLE productvariant ADD COLUMN comparePrice … NULL` |
| 3 | `app/api/admin/products/route.ts` | Validate + persist `comparePrice` on create |
| 4 | `app/api/admin/products/[id]/route.ts` | Persist on update; return in GET |
| 5 | `app/admin/products/new/page.tsx` | Input **Harga Normal** + **Harga Jual**, preview, validation |
| 6 | `app/admin/products/[id]/edit/page.tsx` | Same inputs + validation + preview |
| 7 | `app/api/products/route.ts` | Expose `comparePrice` in variant read model |
| 8 | `app/products/[slug]/page.tsx` | Expose `comparePrice` in serialized detail |
| 9 | `app/home/page.tsx` | Expose + render `comparePrice` in inline card |
| 10 | `app/api/buy-now/route.ts` | Expose `comparePrice` in preview read model |
| 11 | `app/api/cart/route.ts` | Expose `comparePrice` alongside `price`/`originalPrice` |
| 12 | `components/products/ProductCard.tsx` | Render sell price prominent; coret `comparePrice` |
| 13 | `components/products/ProductDetail.tsx` | Same |
| 14 | `components/cart/CartPage.tsx`, `CartPageClient.tsx` | Same (display only) |
| 15 | `app/checkout/CheckoutPage.tsx`, `app/buy-now/BuyNowPage.tsx` | Optional display of coret; **amount must stay `price`** |
| 16 | `app/orders/[id]/page.tsx` | Optional coret from snapshot `comparePrice` if snapshotted |

Validation (rule 7) belongs in the admin API (server) and mirrored in the admin UI:
`comparePrice` nullable; when present, integer rupiah, `> 0`, and `price <= comparePrice`.

## D. Tempat yang HARUS tetap memakai snapshot (JANGAN diubah)

- `OrderItem.price` / `OrderItem.subtotal` — order-time snapshot.
- `Order.subtotal` / `Order.discount` / `Order.total`.
- `lib/refund.ts` — refund amount = `order.total` (snapshot). ✅ already snapshot-based.
- `AffiliateConversion.orderSubtotal/commissionAmount` — snapshot at creation.
- Payment amount + Midtrans/iPaymu item details — from `item.price` / `order.total`.
- `rollbackCheckoutOrder()` / `processRepayment()` — `order.total`.
- TikTok catalog/events — `item.price` snapshot.
- `lib/marketing/broadcast.ts` price-drop detector — compares `OrderItem.price` to current
  `variant.price`; `comparePrice` is irrelevant here, leave as-is.

No existing order may change when an admin edits a product: guaranteed because **no snapshot
field changes and `variant.price` semantics are untouched**.

## E. Migration yang diperlukan

- One **additive** column; no data rewrite of `price`.
  ```sql
  ALTER TABLE `productvariant`
      ADD COLUMN `comparePrice` DECIMAL(12,2) NULL;
  ```
- Backfill: **leave NULL for all existing products** (rule 5/6 — no coret, identical
  customer-facing behaviour). No index/unique constraint needed.
- `OrderItem` / `Order` / affiliate / refund tables: **no migration**.
- Do NOT run `prisma migrate` against production in this phase; produce the migration file only
  (separate, approved deployment step), consistent with project convention.

## F. Risiko regression

1. **Naming collision** with existing `originalPrice`/`effectivePrice` — highest risk; use a new
   distinct field name (`comparePrice`).
2. **Double strikethrough / precedence**: a product can have BOTH a marketing discount
   (`effectivePrice < price`) and a `comparePrice`. Need one rule, e.g.
   primary coret = `comparePrice` when `comparePrice > effectivePrice`, else fall back to the
   marketing `originalPrice`. Must never show `comparePrice` as the checkout amount.
3. **`comparePrice` must never reach checkout**: `createCheckoutOrder` must keep reading only
   `variant.price`/`effectivePrice`. Add a guard test.
4. **Sort/filter by price**: `app/home/page.tsx` orders variants by `price asc`;
   `app/admin/products/page.tsx` client-sorts by variant price. Keep sorting on the **actual**
   price, never `comparePrice`. (No other price sort/filter exists; `/api/products` has no sort param.)
5. **ProductCard range logic** uses min/max of `price`/`effectivePrice` — adding `comparePrice`
   must not break the range/discount-percent display.
6. **Admin validation** must allow null and enforce the `price <= comparePrice` rule only when set.
7. **Cart tampering**: already safe; unchanged — verify no `comparePrice` is trusted from client.
8. Root `products.ts` is a **static mock with no importers** — ignore (not a price source).

---

## Scope summary / effort

- **Schema change:** 1 nullable column + backfill(NULL) + 1 migration file.
- **Server read/write:** 5 API routes + admin API (2) + validation.
- **UI:** admin (2) + customer cards/detail/cart/checkout (≈9 files) — presentation only.
- **Untouched:** checkout math, OrderItem/Order snapshots, voucher, affiliate, refund, payment,
  Mengantar, auth, TikTok, shipping state machine.

## Recommendation (awaiting approval)

1. Approve the **additive `comparePrice`** design (keep `price` = authoritative sell price).
2. Confirm the **strikethrough precedence rule** when a marketing discount also exists.
3. After approval, implement in this order: schema+migration → admin API/validation → admin UI →
   customer read models → customer UI → guard tests → `tsc`, Jest, `prisma validate`, build.

**No implementation started — awaiting your approval.**
