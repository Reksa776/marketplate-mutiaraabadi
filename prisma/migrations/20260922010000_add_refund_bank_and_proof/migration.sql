-- AddRefundBankAndProof: customer destination bank info + proof upload for the Refund flow.
-- Non-destructive: only adds nullable columns; existing rows stay untouched.

ALTER TABLE `refund`
  ADD COLUMN `bankName` VARCHAR(191) NULL,
  ADD COLUMN `bankAccountName` VARCHAR(191) NULL,
  ADD COLUMN `bankAccountNumber` VARCHAR(191) NULL,
  ADD COLUMN `proofFilePath` VARCHAR(191) NULL;