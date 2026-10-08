-- [MASTER-025] Reverse of migration.sql. The receipts' keys and movement links
-- are dropped; the adjustments themselves and every stock movement remain.
BEGIN;
DROP INDEX IF EXISTS "stock_adjustments_itemId_commandKey_key";
ALTER TABLE "stock_adjustments" DROP COLUMN IF EXISTS "movementId";
ALTER TABLE "stock_adjustments" DROP COLUMN IF EXISTS "commandKey";
COMMIT;
