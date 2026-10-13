-- ============================================================
-- WHATSAPP AUTO-REPLY BOT — CONVERSATION STATE + INBOUND DEDUPE
-- ============================================================
-- ADDITIVE + BACKWARD-COMPATIBLE ONLY.
--
--   * No table is dropped or altered.
--   * No row is deleted.
--   * No financial/historical data is touched.
--   * No API key, token or secret is stored anywhere here.
--
-- Two NEW tables are created, both owned exclusively by the
-- WhatsApp auto-reply bot (lib/whatsapp/inbound/*):
--
--   1. whatsapp_chat_state — one row per customer chat (sender JID).
--      Holds the menu/conversation state, the PHONE-VERIFIED order
--      binding, the handoff (bot-paused) window and the per-chat
--      reply budget. It has NO foreign key on purpose: a stale row
--      must never be able to block or cascade into order data, and
--      the row is disposable.
--
--   2. whatsapp_inbound_message — idempotency ledger for inbound
--      messages, keyed by the Baileys message id (`key.id`).
--      status: PROCESSING (claimed) | DONE (replied — a re-delivery
--      is ignored) | FAILED (claiming/replying broke, so a
--      re-delivery MAY retry; this is what keeps a message from
--      being lost permanently merely because its id was recorded).
--
-- Applying this migration is a prerequisite for the bot: until the
-- tables exist, inbound handling fails closed (it stops before any
-- reply) while the rest of the application is unaffected.
-- ============================================================


-- ------------------------------------------------------------
-- 1. CONVERSATION STATE (one row per chat)
-- ------------------------------------------------------------
CREATE TABLE `whatsapp_chat_state` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `chatId` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'IDLE',
    `verifiedOrderId` INTEGER NULL,
    `verifiedAt` DATETIME(3) NULL,
    `pendingIntent` VARCHAR(191) NULL,
    `pauseUntil` DATETIME(3) NULL,
    `blockedUntil` DATETIME(3) NULL,
    `failedBindAttempts` INTEGER NOT NULL DEFAULT 0,
    `replyCount` INTEGER NOT NULL DEFAULT 0,
    `windowStartedAt` DATETIME(3) NULL,
    `lastActivityAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastReplyAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `whatsapp_chat_state_chatId_key`(`chatId`),
    INDEX `whatsapp_chat_state_pauseUntil_idx`(`pauseUntil`),
    INDEX `whatsapp_chat_state_lastActivityAt_idx`(`lastActivityAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


-- ------------------------------------------------------------
-- 2. INBOUND MESSAGE LEDGER (idempotency)
-- ------------------------------------------------------------
CREATE TABLE `whatsapp_inbound_message` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `messageId` VARCHAR(191) NOT NULL,
    `chatId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PROCESSING',
    `attempts` INTEGER NOT NULL DEFAULT 1,
    `lastError` TEXT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `processedAt` DATETIME(3) NULL,

    UNIQUE INDEX `whatsapp_inbound_message_messageId_key`(`messageId`),
    INDEX `whatsapp_inbound_message_receivedAt_idx`(`receivedAt`),
    INDEX `whatsapp_inbound_message_status_receivedAt_idx`(`status`, `receivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
