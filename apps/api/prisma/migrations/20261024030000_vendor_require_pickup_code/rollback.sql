-- Rollback for 20261024030000_vendor_require_pickup_code
-- Roll back the CODE first: the application reads and writes "requirePickupCode" (store profile,
-- complete-pickup, the store card); dropping the column under it breaks those requests.
-- A store's ON setting is lost on rollback (every store returns to the pre-O-2 behaviour, code required).
SET lock_timeout = '10s';
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "requirePickupCode";
