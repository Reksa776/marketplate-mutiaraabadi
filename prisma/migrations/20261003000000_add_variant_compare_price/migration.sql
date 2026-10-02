-- ============================================================
-- ProductVariant.comparePrice — DISPLAY-ONLY "Harga Normal"
-- ============================================================
-- ADDITIVE ONLY. Nullable column.
--
--   * Existing rows remain NULL → identical customer-facing
--     behaviour (no strikethrough).
--   * `price` (authoritative sell price) is NOT modified.
--   * Order / OrderItem / affiliate / refund / payment tables are
--     NOT modified. Historical orders are untouched.
--   * comparePrice is NEVER used for checkout/payment/order totals.
-- ============================================================

ALTER TABLE `productvariant`
    ADD COLUMN `comparePrice` DECIMAL(12, 2) NULL;
