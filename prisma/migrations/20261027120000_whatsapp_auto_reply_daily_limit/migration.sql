-- Track the once-per-24-hours quota for unsolicited bot replies
-- independently from customer-requested service replies.
ALTER TABLE `whatsapp_chat_state`
    ADD COLUMN `lastAutoReplyAt` DATETIME(3) NULL;

-- Preserve the existing cooldown after deployment for chats that already
-- received a bot reply; later service replies do not reset this quota.
UPDATE `whatsapp_chat_state`
SET `lastAutoReplyAt` = `lastReplyAt`
WHERE `lastReplyAt` IS NOT NULL;
