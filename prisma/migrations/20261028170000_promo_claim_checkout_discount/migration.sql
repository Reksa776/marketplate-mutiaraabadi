-- A promo claim grants the configured product price directly at checkout;
-- it no longer depends on a separately managed Voucher record.
ALTER TABLE `promolanding`
    DROP FOREIGN KEY `promolanding_voucherId_fkey`,
    DROP INDEX `promolanding_voucherId_idx`,
    DROP COLUMN `voucherId`;

ALTER TABLE `promoclaim`
    DROP COLUMN `voucherCode`;

-- A claim is only counted against the daily quota when a checkout order is
-- successfully created. The order link prevents reusing one claim twice.
ALTER TABLE `promoclaim`
    ADD COLUMN `checkoutOrderId` INTEGER NULL,
    ADD UNIQUE INDEX `promoclaim_checkoutOrderId_key`(`checkoutOrderId`);
