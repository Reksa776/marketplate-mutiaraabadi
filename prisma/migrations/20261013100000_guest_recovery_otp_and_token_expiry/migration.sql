-- ============================================================
-- GUEST ORDER RECOVERY (OTP) + SERVER-SIDE TOKEN EXPIRY
-- ============================================================
-- ADDITIVE + BACKWARD-COMPATIBLE ONLY.
--
--   * No table is dropped.
--   * No row is deleted.
--   * No financial/historical data is touched.
--
-- Guarantees introduced:
--   1. Order.guestAccessTokenExpiresAt — the guest access token now
--      has a SERVER-SIDE 30-day validity window that is enforced in
--      resolveOrderAccess(). A token whose window has passed is never
--      accepted again, whatever the browser cookie still says.
--
--      BACKFILL: every order that currently holds a token is given a
--      window starting from the migration instant (NOW + 30 days) —
--      NOT from its creation date. Buyers who legitimately hold a
--      token today therefore keep their access for a further 30 days
--      instead of being logged out by the migration itself. Orders
--      whose token expired in the meantime are recovered through the
--      OTP flow below; nothing is deleted and no order becomes
--      unreadable (historical orders are preserved).
--
--   2. guestrecoverychallenge — two-phase OTP recovery for a guest
--      order whose cookie is gone or expired:
--        * the access token is NEVER rotated before OTP verification,
--        * the challenge is SINGLE USE (consumedAt),
--        * SHORT LIVED (expiresAt, 10 minutes),
--        * ATTEMPT LIMITED (attempts / maxAttempts),
--        * BOUND to the order AND to the checkout contact that was
--          matched in phase 1 (contactHash),
--        * FAIL CLOSED when delivery fails (deliveredAt stays NULL).
--
--      Only keyed HMAC hashes are stored: the raw OTP and the raw
--      buyer contact are never persisted.
--
-- No API key, token or secret is ever stored in the database.
-- ============================================================


-- ------------------------------------------------------------
-- 1. ORDER — server-side guest token expiry
-- ------------------------------------------------------------
ALTER TABLE `order`
    ADD COLUMN `guestAccessTokenExpiresAt` DATETIME(3) NULL;

-- Backfill: existing tokens get a fresh 30-day window from now, so
-- this migration never locks a legitimate buyer out. Rows without a
-- token stay NULL (they have no guest token to expire).
UPDATE `order`
SET `guestAccessTokenExpiresAt` = DATE_ADD(NOW(3), INTERVAL 30 DAY)
WHERE `guestAccessTokenHash` IS NOT NULL
  AND `guestAccessTokenExpiresAt` IS NULL;


-- ------------------------------------------------------------
-- 2. GUEST RECOVERY CHALLENGE
-- ------------------------------------------------------------
CREATE TABLE `guestrecoverychallenge` (
    `id`             VARCHAR(191) NOT NULL,
    `orderId`        INTEGER NOT NULL,
    `orderNumber`    VARCHAR(191) NOT NULL,
    `channel`        VARCHAR(191) NOT NULL DEFAULT 'whatsapp',
    `contactChannel` VARCHAR(191) NOT NULL,
    `contactHash`    VARCHAR(191) NOT NULL,
    `codeHash`       VARCHAR(191) NOT NULL,
    `attempts`       INTEGER NOT NULL DEFAULT 0,
    `maxAttempts`    INTEGER NOT NULL DEFAULT 5,
    `deliveredAt`    DATETIME(3) NULL,
    `deliveryError`  TEXT NULL,
    `consumedAt`     DATETIME(3) NULL,
    `expiresAt`      DATETIME(3) NOT NULL,
    `notificationId` INTEGER NULL,
    `createdAt`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`      DATETIME(3) NOT NULL,

    INDEX `guestrecoverychallenge_orderId_consumedAt_idx` (`orderId`, `consumedAt`),
    INDEX `guestrecoverychallenge_expiresAt_idx` (`expiresAt`),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `guestrecoverychallenge`
    ADD CONSTRAINT `guestrecoverychallenge_orderId_fkey`
    FOREIGN KEY (`orderId`) REFERENCES `order`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
