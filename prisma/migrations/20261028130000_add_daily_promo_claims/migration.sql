CREATE TABLE `promolanding` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `voucherId` INTEGER NOT NULL,
    `dailyQuota` INTEGER NOT NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `promolanding_slug_key`(`slug`),
    INDEX `promolanding_isActive_startAt_endAt_idx`(`isActive`, `startAt`, `endAt`),
    INDEX `promolanding_voucherId_idx`(`voucherId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `promodailyquota` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `promoId` INTEGER NOT NULL,
    `quotaDate` DATE NOT NULL,
    `claimedCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `promodailyquota_promoId_quotaDate_key`(`promoId`, `quotaDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `promoclaim` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `promoId` INTEGER NOT NULL,
    `quotaDate` DATE NOT NULL,
    `visitorKeyHash` CHAR(64) NOT NULL,
    `voucherCode` VARCHAR(191) NOT NULL,
    `claimedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `promoclaim_promoId_quotaDate_visitorKeyHash_key`(`promoId`, `quotaDate`, `visitorKeyHash`),
    INDEX `promoclaim_promoId_quotaDate_idx`(`promoId`, `quotaDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `promolanding`
    ADD CONSTRAINT `promolanding_voucherId_fkey`
    FOREIGN KEY (`voucherId`) REFERENCES `voucher`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `promodailyquota`
    ADD CONSTRAINT `promodailyquota_promoId_fkey`
    FOREIGN KEY (`promoId`) REFERENCES `promolanding`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `promoclaim`
    ADD CONSTRAINT `promoclaim_promoId_fkey`
    FOREIGN KEY (`promoId`) REFERENCES `promolanding`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
