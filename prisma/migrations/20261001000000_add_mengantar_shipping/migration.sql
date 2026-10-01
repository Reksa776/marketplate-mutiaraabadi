-- ============================================================
-- Mengantar shipping/fulfilment integration
-- ============================================================
-- ADDITIVE + NULLABLE ONLY.
--
-- Existing rows (and the whole legacy RajaOngkir flow) keep working:
-- every new column defaults to NULL and no existing column/enum is
-- touched. Existing orders remain readable.
--
-- No API key / token / secret is ever stored in the database.
-- ============================================================

-- ---- UserAddress: Mengantar destination area reference ----
ALTER TABLE `useraddress`
    ADD COLUMN `mengantarDestinationAreaId` VARCHAR(191) NULL;

-- ---- StoreSetting: Mengantar pickup/origin configuration ----
ALTER TABLE `storesetting`
    ADD COLUMN `mengantarOriginAreaId` VARCHAR(191) NULL,
    ADD COLUMN `mengantarPickupAddressId` VARCHAR(191) NULL,
    ADD COLUMN `mengantarPickupTimeId` VARCHAR(191) NULL;

-- ---- Order: shipping fulfilment provider fields ----
ALTER TABLE `order`
    ADD COLUMN `shippingProvider` VARCHAR(191) NULL,
    ADD COLUMN `providerShipmentId` VARCHAR(191) NULL,
    ADD COLUMN `providerBatchId` VARCHAR(191) NULL,
    ADD COLUMN `providerCourier` VARCHAR(191) NULL,
    ADD COLUMN `shippingPaymentStatus` VARCHAR(191) NULL,
    ADD COLUMN `shipmentStatus` VARCHAR(191) NULL,
    ADD COLUMN `codAmount` DECIMAL(12, 2) NULL;

CREATE INDEX `Order_providerShipmentId_idx` ON `order`(`providerShipmentId`);
