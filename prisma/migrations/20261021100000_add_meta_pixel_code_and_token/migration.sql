-- Store the Meta Pixel base code and server-only Conversions API token.
-- The physical table is lowercase in Prisma (`@@map("storesetting")`).
ALTER TABLE `storesetting`
  ADD COLUMN `metaPixelCode` TEXT NULL,
  ADD COLUMN `metaPixelAccessToken` TEXT NULL;
