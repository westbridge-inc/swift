-- Rollback for 20261021030000_fee_receipt_allocations: drops the record of which receipt paid which week (receipts then
-- print the "paid toward" line again) and the weeksTracked flag. Receipts themselves are untouched.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP TABLE IF EXISTS "fee_receipt_allocations";
DROP FUNCTION IF EXISTS fee_receipt_allocation_immutable();
ALTER TABLE "fee_receipts" DROP COLUMN IF EXISTS "weeksTracked";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261021030000_fee_receipt_allocations';
COMMIT;
