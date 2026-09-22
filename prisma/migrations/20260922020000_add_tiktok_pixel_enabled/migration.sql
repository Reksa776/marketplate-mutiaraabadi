-- AddTikTokPixelEnabled: explicit on/off switch for the TikTok Pixel base code.
--
-- Non-destructive: only adds one NOT NULL column with a default, so existing
-- rows stay valid without a table rebuild.
--
-- The base code was previously injected on the storefront whenever
-- `tiktokPixelId` was non-empty, so the backfill preserves the current live
-- behaviour (a store that already configured a Pixel ID keeps tracking).
-- Stores that never configured an ID stay disabled.

ALTER TABLE `storesetting`
  ADD COLUMN `tiktokPixelEnabled` BOOLEAN NOT NULL DEFAULT false;

UPDATE `storesetting`
SET `tiktokPixelEnabled` = true
WHERE `tiktokPixelId` IS NOT NULL
  AND TRIM(`tiktokPixelId`) <> '';
