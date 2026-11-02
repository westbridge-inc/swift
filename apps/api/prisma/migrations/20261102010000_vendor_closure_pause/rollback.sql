-- [WEB-DELETE] Rollback of 20261102010000_vendor_closure_pause: roll the application back first (it writes the column).
SET lock_timeout = '10s';
ALTER TABLE "vendors" DROP CONSTRAINT IF EXISTS "vendors_closure_pause_keeps_intake_off";
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "closurePausedAt";
