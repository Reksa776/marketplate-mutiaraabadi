-- The first promo migration may already be recorded as applied on servers.
-- Add target product and configured price in a follow-up migration so those
-- databases can upgrade without resetting or inventing data for old promos.
ALTER TABLE `promolanding`
    ADD COLUMN `productId` INTEGER NULL,
    ADD COLUMN `variantId` INTEGER NULL,
    ADD COLUMN `promoPrice` DECIMAL(12, 2) NULL,
    ADD INDEX `promolanding_productId_idx`(`productId`),
    ADD INDEX `promolanding_variantId_isActive_startAt_endAt_idx`(`variantId`, `isActive`, `startAt`, `endAt`);

ALTER TABLE `promolanding`
    ADD CONSTRAINT `promolanding_productId_fkey`
    FOREIGN KEY (`productId`) REFERENCES `product`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `promolanding`
    ADD CONSTRAINT `promolanding_variantId_fkey`
    FOREIGN KEY (`variantId`) REFERENCES `productvariant`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
