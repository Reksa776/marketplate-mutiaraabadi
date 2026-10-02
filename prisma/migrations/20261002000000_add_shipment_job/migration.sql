-- ============================================================
-- ShipmentJob — durable outbox for AUTO MENGANTAR SHIPPING
-- ============================================================
-- ADDITIVE ONLY. No existing column/enum/table is touched.
--
-- Guarantees exactly one Mengantar shipment is eventually created
-- for an authoritatively-PAID order, surviving restarts and
-- concurrent workers (claim via CAS on status/nextAttemptAt).
--
-- No API key / token / secret is ever stored in the database.
-- ============================================================

CREATE TABLE `shipmentjob` (
    `id`              INTEGER NOT NULL AUTO_INCREMENT,
    `orderId`         INTEGER NOT NULL,
    `status`          VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `stage`           VARCHAR(191) NOT NULL DEFAULT 'CREATE',
    `attempts`        INTEGER NOT NULL DEFAULT 0,
    `maxAttempts`     INTEGER NOT NULL DEFAULT 6,
    `lastError`       TEXT NULL,
    `nextAttemptAt`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lockedAt`        DATETIME(3) NULL,
    `pickupAddressId` VARCHAR(191) NULL,
    `pickupTimeId`    VARCHAR(191) NULL,
    `pickupDate`      VARCHAR(191) NULL,
    `pickupTime`      VARCHAR(191) NULL,
    `createdAt`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`       DATETIME(3) NOT NULL,

    UNIQUE INDEX `shipmentjob_orderId_key` (`orderId`),
    INDEX `shipmentjob_status_nextAttemptAt_idx` (`status`, `nextAttemptAt`),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `shipmentjob`
    ADD CONSTRAINT `shipmentjob_orderId_fkey`
    FOREIGN KEY (`orderId`) REFERENCES `order`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
