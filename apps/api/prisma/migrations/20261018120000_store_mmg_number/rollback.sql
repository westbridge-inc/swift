-- Rollback for 20261018120000_store_mmg_number: drops the store MMG number columns, its index and the
-- order snapshot. Numbers stores entered are lost (they re-enter them); orders placed to a number lose the
-- committed number (an accepted, unpaid one then shows no number: the customer pays cash or asks the store).
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP INDEX IF EXISTS "vendors_mmgNumberApplyAt_idx";
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "mmgNumberApplyAt";
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "mmgNumberPendingAt";
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "mmgNumberPending";
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "mmgNumber";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "mmgNumberSnapshot";
COMMIT;
