CREATE TABLE `siteanalyticsevent` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `visitorId` VARCHAR(36) NOT NULL,
  `sessionId` VARCHAR(36) NOT NULL,
  `eventType` VARCHAR(24) NOT NULL,
  `path` VARCHAR(512) NOT NULL,
  `referrerHost` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `siteanalyticsevent_createdAt_eventType_idx` (`createdAt`, `eventType`),
  INDEX `siteanalyticsevent_visitorId_createdAt_idx` (`visitorId`, `createdAt`),
  INDEX `siteanalyticsevent_path_createdAt_idx` (`path`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
