-- Add optional Meta Pixel settings.
-- Prisma maps the model to the lowercase physical table name. Keep this
-- identifier case aligned with @@map("storesetting") for case-sensitive
-- MySQL installations.
ALTER TABLE `storesetting`
  ADD COLUMN `metaPixelEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `metaPixelId` VARCHAR(191) NULL;
