-- [Owner 4 Nov 2026] The taxi waiting charge starts only when GPS puts the car at the pickup
-- (rides/taxi-waiting.ts). The ride's terms row records that verdict with each arrival.
-- EXPAND only: one nullable column on taxi_ride_waiting; null is never billed.
--
-- FORWARD
--  1. taxi_ride_waiting."pickupArrivalVerified": true when the arrival gate placed the car at the
--     pickup, false when the passenger confirmed an arrival the GPS did not back.
--
-- ROLLBACK: rollback.sql beside this file (drops the column; roll the application back first).
SET lock_timeout = '10s';

ALTER TABLE "taxi_ride_waiting" ADD COLUMN IF NOT EXISTS "pickupArrivalVerified" BOOLEAN;
