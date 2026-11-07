-- Rollback for 20261024040000_stock_adjustment_command_receipt
-- [MASTER-025] Reverse of migration.sql. The receipts' keys and movement links
-- are dropped; the adjustments themselves and every stock movement remain.
-- Roll back the CODE first: POST /vendor/items/:id/adjust writes "commandKey"
-- and "movementId"; dropping them under it breaks every stock adjustment.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP INDEX IF EXISTS "stock_adjustments_itemId_commandKey_key";
ALTER TABLE "stock_adjustments" DROP COLUMN IF EXISTS "movementId";
ALTER TABLE "stock_adjustments" DROP COLUMN IF EXISTS "commandKey";
COMMIT;
