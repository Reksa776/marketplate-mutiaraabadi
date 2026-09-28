-- AddStoreFavicon: public URL/path of the admin-uploaded website favicon.
--
-- Additive and non-destructive: one NULLABLE column is added, so existing
-- rows stay valid and no existing column is changed or dropped.
--
-- Deliberately NULL by default and NO backfill: when NULL the storefront
-- falls back to the bundled app icons (app/icon.ico / app/icon.svg /
-- app/apple-icon.png), which is the current live behaviour. The uploaded
-- binary itself lives on the existing local upload storage — only the
-- public URL is stored here.

ALTER TABLE `storesetting`
  ADD COLUMN `faviconUrl` TEXT NULL;
