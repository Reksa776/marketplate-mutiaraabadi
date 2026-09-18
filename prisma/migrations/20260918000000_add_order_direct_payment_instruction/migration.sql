-- iPaymu Direct Payment migration.
--
-- The customer now pays on OUR payment page instead of being redirected to
-- iPaymu's hosted page, so the instruction returned by
-- POST /api/v2/payment/direct must be persisted server-side (the browser may
-- never call iPaymu directly, and a page refresh must still render it).
--
-- Stored columns are a sanitized subset of the provider response `Data`:
--   paymentNo        → PaymentNo        (VA number / payment code)
--   paymentUrl       → Url              (QR image URL for QRIS, e-wallet link)
--   paymentChannel   → Channel          (bca, mandiri, qris, dana, ...)
--   paymentExpiresAt → Expired          (provider expiry, WIB → UTC)
--
-- Merchant credentials (VA / API key / signature) are NEVER stored or exposed.

ALTER TABLE `order`
  ADD COLUMN `paymentNo` VARCHAR(191) NULL,
  ADD COLUMN `paymentUrl` TEXT NULL,
  ADD COLUMN `paymentChannel` VARCHAR(191) NULL,
  ADD COLUMN `paymentExpiresAt` DATETIME(3) NULL;

ALTER TABLE `order`
  ADD INDEX `order_paymentExpiresAt_idx` (`paymentExpiresAt`);
