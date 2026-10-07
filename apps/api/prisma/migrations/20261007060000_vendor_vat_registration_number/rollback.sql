-- Rollback for 20261007060000_vendor_vat_registration_number: drops the optional VAT number column.
-- Any numbers stores typed are lost; nothing else reads the column.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "vatRegistrationNumber";
COMMIT;
