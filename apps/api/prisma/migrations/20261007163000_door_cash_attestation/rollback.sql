-- ROLLBACK for 20261007163000_door_cash_attestation.
--
-- Roll the application back first: the previous application never reads or
-- writes these columns. Dropping them discards every stated door-cash amount
-- and every held short-handover record. Export them first if any exist:
--   SELECT "id", "orderNumber", "doorCashCollectedAmount", "doorCashShortfallAmount", "doorCashMismatchAt"
--   FROM "orders" WHERE "doorCashCollectedAmount" IS NOT NULL OR "doorCashMismatchAt" IS NOT NULL;
-- Forward repair (re-apply the migration and the application) is preferred.
SET lock_timeout = '10s';
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_door_cash_mismatch_carries_shortfall";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_door_cash_shortfall_whole_positive";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_door_cash_collected_whole";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "doorCashMismatchAt";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "doorCashShortfallAmount";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "doorCashCollectedAmount";
