-- Ensure existing deployments receive the checkout-order link even if the
-- preceding promo migration was already recorded before this column existed.
-- The conditional DDL also handles databases where the preceding migration
-- has not run yet and already creates the column/index.
SET @checkout_order_column_exists = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'promoclaim'
      AND COLUMN_NAME = 'checkoutOrderId'
);
SET @checkout_order_column_sql = IF(
    @checkout_order_column_exists = 0,
    'ALTER TABLE `promoclaim` ADD COLUMN `checkoutOrderId` INTEGER NULL',
    'SELECT 1'
);
PREPARE checkout_order_column_stmt FROM @checkout_order_column_sql;
EXECUTE checkout_order_column_stmt;
DEALLOCATE PREPARE checkout_order_column_stmt;

SET @checkout_order_index_exists = (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'promoclaim'
      AND INDEX_NAME = 'promoclaim_checkoutOrderId_key'
);
SET @checkout_order_index_sql = IF(
    @checkout_order_index_exists = 0,
    'CREATE UNIQUE INDEX `promoclaim_checkoutOrderId_key` ON `promoclaim` (`checkoutOrderId`)',
    'SELECT 1'
);
PREPARE checkout_order_index_stmt FROM @checkout_order_index_sql;
EXECUTE checkout_order_index_stmt;
DEALLOCATE PREPARE checkout_order_index_stmt;
