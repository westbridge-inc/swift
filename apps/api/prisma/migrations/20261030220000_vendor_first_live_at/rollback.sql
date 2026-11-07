-- Rollback of 20261030220000_vendor_first_live_at. Roll the application back first (it reads the column).
-- Forward repair is preferred: re-applying the forward migration re-marks only what the backfill can see (createdAt
-- stands in for the first go-live), so a store that went live with no subscription and no order since would read as
-- never live again.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "firstLiveAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030220000_vendor_first_live_at';
COMMIT;
