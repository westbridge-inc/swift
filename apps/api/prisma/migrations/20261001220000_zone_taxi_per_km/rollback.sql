-- ROLLBACK for 20261001220000_zone_taxi_per_km.
--
-- Roll the application back first: the previous application never reads the
-- column. Dropping it discards every zone's per-km rate, so a trip that starts
-- or ends in such a zone prices at the market's per-km rate again. Forward
-- repair is preferred: re-apply the migration, then set each rate again with
-- PUT /api/v1/admin/zones/:id { "taxiPerKm": <whole GYD> } (a fresh install's
-- seed sets the airport zones' 295 itself).
SET lock_timeout = '10s';
ALTER TABLE "zones" DROP CONSTRAINT IF EXISTS "zones_taxi_per_km_whole_positive";
ALTER TABLE "zones" DROP COLUMN IF EXISTS "taxiPerKm";
