-- Phase 22: TikTok attribution on `order`.
--
-- Additive and non-destructive: six NULLABLE columns are added. Existing
-- rows stay valid and no existing column is changed or dropped.
--
-- These values are captured at the CUSTOMER request boundary when the
-- order is created (never from the payment webhook) and are forwarded,
-- unhashed, to the server-side TikTok Events API CompletePayment call:
--
--   ttclid          → `?ttclid=...` from the first landing URL
--   ttp             → TikTok's own `_ttp` cookie value (null when absent)
--   landingUrl      → first landing URL of the visit
--   referrer        → first referrer of the visit
--   clientIp        → customer request IP (trusted-proxy aware)
--   clientUserAgent → customer request User-Agent
--
-- NULL means "the customer did not arrive from TikTok" or "not available":
-- nothing is fabricated or backfilled.

ALTER TABLE `order`
  ADD COLUMN `ttclid` VARCHAR(191) NULL,
  ADD COLUMN `ttp` VARCHAR(191) NULL,
  ADD COLUMN `landingUrl` TEXT NULL,
  ADD COLUMN `referrer` TEXT NULL,
  ADD COLUMN `clientIp` VARCHAR(191) NULL,
  ADD COLUMN `clientUserAgent` TEXT NULL;
