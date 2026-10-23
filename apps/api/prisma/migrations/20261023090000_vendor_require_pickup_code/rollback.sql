-- Rollback for 20261023090000_vendor_require_pickup_code
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "requirePickupCode";
