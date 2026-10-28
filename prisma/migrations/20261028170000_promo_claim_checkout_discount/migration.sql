-- A promo claim grants the configured product price directly at checkout;
-- it no longer depends on a separately managed Voucher record.
ALTER TABLE `promolanding`
    DROP FOREIGN KEY `promolanding_voucherId_fkey`,
    DROP INDEX `promolanding_voucherId_idx`,
    DROP COLUMN `voucherId`;

ALTER TABLE `promoclaim`
    DROP COLUMN `voucherCode`;
