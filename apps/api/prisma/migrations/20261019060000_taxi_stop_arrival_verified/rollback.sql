-- Rollback for 20261019060000_taxi_stop_arrival_verified: drops the stop arrival's verification answer.
-- After it the waiting charge has nothing to read, so the code it shipped with must be rolled back first.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "taxi_trip_stops" DROP COLUMN IF EXISTS "arrivalVerified";
COMMIT;
