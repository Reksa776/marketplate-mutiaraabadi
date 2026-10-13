-- ============================================================
-- GUEST CHECKOUT — guest orders, guest identity & guest cart
-- ============================================================
-- ADDITIVE + BACKWARD-COMPATIBLE ONLY.
--
--   * No table is dropped.
--   * No row is deleted.
--   * No financial/historical data is touched.
--   * Every NOT NULL column added here is backfilled from existing
--     data BEFORE the constraint is enforced, so the migration is
--     safe on a populated `order` table (MySQL/MariaDB).
--
-- Guarantees introduced:
--   1. Order.userId becomes NULLABLE and its FK changes to
--      ON DELETE SET NULL — deleting a customer row can never
--      cascade-delete order / OrderItem / financial history again.
--   2. Orders carry a guest buyer identity:
--        customerEmail        = buyer email (iPaymu buyerEmail source)
--        guestAccessTokenHash = SHA-256 of the guest access token
--                               (raw token is NEVER stored)
--        guestIdentityKey     = normalized + hashed contact identity
--                               (email/phone) for per-identity limits
--        idempotencyKey       = duplicate-submission guard
--   3. COD abuse control: requiresCodReview / codReviewStatus /
--      codReviewedAt / codReviewedBy. A flagged order is HELD (no
--      ShipmentJob) until an admin approves — never auto-cancelled.
--   4. Cart supports an anonymous guest scope via guestTokenHash
--      (SHA-256 of the cookie token; raw token is never stored).
--   5. Voucher / Flash-Sale per-user caps stay enforceable for
--      guests through an `ownerKey` scope column:
--        logged-in → 'user:<userId>'
--        guest     → 'guest:<guestIdentityKey>'
--      Historical rows are backfilled from userId so existing
--      limits are preserved exactly.
--
-- No API key, token or secret is ever stored in the database.
-- ============================================================


-- ------------------------------------------------------------
-- 1. ORDER — nullable userId + SetNull, guest identity, COD gate
-- ------------------------------------------------------------
-- Drop the CASCADE FK first: the column cannot be made nullable
-- while a CASCADE constraint still treats it as required.
ALTER TABLE `order` DROP FOREIGN KEY `Order_userId_fkey`;

ALTER TABLE `order`
    ADD COLUMN `customerEmail`        VARCHAR(191) NULL,
    ADD COLUMN `guestAccessTokenHash` VARCHAR(191) NULL,
    ADD COLUMN `guestIdentityKey`     VARCHAR(191) NULL,
    ADD COLUMN `idempotencyKey`       VARCHAR(191) NULL,
    ADD COLUMN `requiresCodReview`    BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `codReviewStatus`      VARCHAR(191) NULL,
    ADD COLUMN `codReviewedAt`        DATETIME(3) NULL,
    ADD COLUMN `codReviewedBy`        VARCHAR(191) NULL,
    MODIFY `userId` VARCHAR(191) NULL;

-- Re-add as SET NULL (never CASCADE for financial history).
ALTER TABLE `order`
    ADD CONSTRAINT `order_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `user`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Unique guest access token hash. MySQL/MariaDB unique indexes allow
-- many NULLs, so all existing (logged-in) rows keep NULL safely.
CREATE UNIQUE INDEX `order_guestAccessTokenHash_key` ON `order`(`guestAccessTokenHash`);

-- Unique idempotency key: a duplicate checkout submission collides
-- here instead of creating a second order.
CREATE UNIQUE INDEX `order_idempotencyKey_key` ON `order`(`idempotencyKey`);

-- Guest per-identity abuse lookups (voucher/COD caps, self-referral).
CREATE INDEX `order_guestIdentityKey_idx` ON `order`(`guestIdentityKey`);


-- ------------------------------------------------------------
-- 2. CART — anonymous guest scope
-- ------------------------------------------------------------
-- userId stays CASCADE (a cart is ephemeral scope, not history).
ALTER TABLE `cart`
    ADD COLUMN `guestTokenHash` VARCHAR(191) NULL,
    MODIFY `userId` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `cart_guestTokenHash_key` ON `cart`(`guestTokenHash`);


-- ------------------------------------------------------------
-- 3. FLASHSALEPURCHASE — ownerKey purchase-limit scope
-- ------------------------------------------------------------
ALTER TABLE `flashsalepurchase` DROP FOREIGN KEY `FlashSalePurchase_userId_fkey`;

ALTER TABLE `flashsalepurchase`
    ADD COLUMN `ownerKey` VARCHAR(191) NULL,
    MODIFY `userId` VARCHAR(191) NULL;

-- BACKFILL: every historical row belonged to a logged-in user, so the
-- scope is 'user:<userId>'. This preserves the existing per-user
-- purchase limit for all pre-existing purchases.
UPDATE `flashsalepurchase`
SET `ownerKey` = CONCAT('user:', `userId`)
WHERE `ownerKey` IS NULL;

-- Only now enforce NOT NULL.
ALTER TABLE `flashsalepurchase` MODIFY `ownerKey` VARCHAR(191) NOT NULL;

ALTER TABLE `flashsalepurchase`
    ADD CONSTRAINT `flashsalepurchase_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `user`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Replace the (flashSaleId, userId) uniqueness with (flashSaleId,
-- ownerKey): a nullable userId would make every guest distinct and
-- silently disable the limit.
DROP INDEX `FlashSalePurchase_flashSaleId_userId_key` ON `flashsalepurchase`;

CREATE UNIQUE INDEX `flashsalepurchase_flashSaleId_ownerKey_key`
    ON `flashsalepurchase`(`flashSaleId`, `ownerKey`);

CREATE INDEX `flashsalepurchase_ownerKey_idx` ON `flashsalepurchase`(`ownerKey`);


-- ------------------------------------------------------------
-- 4. VOUCHERUSERUSAGE — ownerKey maxUsagePerUser scope
-- ------------------------------------------------------------
ALTER TABLE `voucheruserusage` DROP FOREIGN KEY `VoucherUserUsage_userId_fkey`;

ALTER TABLE `voucheruserusage`
    ADD COLUMN `ownerKey` VARCHAR(191) NULL,
    MODIFY `userId` VARCHAR(191) NULL;

-- BACKFILL: existing usage belongs to logged-in users.
UPDATE `voucheruserusage`
SET `ownerKey` = CONCAT('user:', `userId`)
WHERE `ownerKey` IS NULL;

ALTER TABLE `voucheruserusage` MODIFY `ownerKey` VARCHAR(191) NOT NULL;

ALTER TABLE `voucheruserusage`
    ADD CONSTRAINT `voucheruserusage_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `user`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX `VoucherUserUsage_voucherId_userId_key` ON `voucheruserusage`;

CREATE UNIQUE INDEX `voucheruserusage_voucherId_ownerKey_key`
    ON `voucheruserusage`(`voucherId`, `ownerKey`);

CREATE INDEX `voucheruserusage_ownerKey_idx` ON `voucheruserusage`(`ownerKey`);


-- ------------------------------------------------------------
-- 5. SPINWHEELSPIN — ownerKey ownership / spin-cap scope
-- ------------------------------------------------------------
ALTER TABLE `spinwheelspin` DROP FOREIGN KEY `SpinWheelSpin_userId_fkey`;

ALTER TABLE `spinwheelspin`
    ADD COLUMN `ownerKey` VARCHAR(191) NULL,
    MODIFY `userId` VARCHAR(191) NULL;

-- BACKFILL: existing spins belong to logged-in users.
UPDATE `spinwheelspin`
SET `ownerKey` = CONCAT('user:', `userId`)
WHERE `ownerKey` IS NULL;

ALTER TABLE `spinwheelspin` MODIFY `ownerKey` VARCHAR(191) NOT NULL;

ALTER TABLE `spinwheelspin`
    ADD CONSTRAINT `spinwheelspin_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `user`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX `spinwheelspin_ownerKey_idx` ON `spinwheelspin`(`ownerKey`);
