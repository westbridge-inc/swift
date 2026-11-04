-- [Owner 4 Nov 2026] Rollback of 20261104140000_taxi_waiting_pickup_gps: roll the application back first (it reads this).
SET lock_timeout = '10s';
ALTER TABLE "taxi_ride_waiting" DROP COLUMN IF EXISTS "pickupArrivalVerified";
