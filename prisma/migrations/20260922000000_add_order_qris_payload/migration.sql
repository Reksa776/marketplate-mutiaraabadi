-- QRIS end-to-end migration.
--
-- QRIS payments are delivered by POST /api/v2/payment/direct through three
-- provider fields:
--
--   QrImage (live shape) / Url (documented shape) → the QR **image** URL,
--             persisted in `paymentUrl` and rendered with <img>.
--   QrString / PaymentNo → the RAW QRIS payload (QR content). It is
--             persisted in the new `qrString` column so the payment page can
--             render a QR from it (qrcode.react) when no image URL is
--             servable. It is NEVER shown to the customer as text.
--
-- `paymentNo` is widened to LONGTEXT (it already is LONGTEXT in the live
-- database) because a real QRIS payload echoed in `Data.PaymentNo` no longer
-- gets stored there — but existing production values up to that size are
-- kept intact and the schema must not fight the running column type.
-- `qrString` is LONGTEXT so real payloads fit without truncation.

ALTER TABLE `order`
  ADD COLUMN `qrString` LONGTEXT NULL;

ALTER TABLE `order`
  MODIFY COLUMN `paymentNo` LONGTEXT NULL;