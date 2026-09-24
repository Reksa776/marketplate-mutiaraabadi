-- AddTikTokPixelAccessToken: server-only TikTok Events API credential.
--
-- Additive and non-destructive: one NULLABLE column is added. Existing rows
-- stay valid and no TikTok field is changed or dropped.
--
-- Deliberately NO backfill: the Access Token is a secret that is only ever
-- entered by an ADMIN in the dashboard. Writing any value here (even a
-- placeholder) would be wrong, and a secret must never live in migration
-- history.

ALTER TABLE `storesetting`
  ADD COLUMN `tiktokPixelAccessToken` TEXT NULL;
