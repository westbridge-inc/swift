-- [ZONE-FARES] A zone's own taxi per-km rate (owner, 1 Oct 2026).
--
-- The owner ruled that an airport prices per kilometre, never as a fixed
-- zone-to-zone fare: a fixed fare is unfair to people who live near the
-- airport. A zone may now carry its own taxi per-km rate. When a trip's pickup
-- or dropoff resolves to a zone that sets one, the country formula charges it
-- for every kilometre beyond the included ones (the higher of the two ends
-- when both set one); the base fare and the included kilometres stay the
-- market's. A fixed fare for the pair (zone_fares) still wins over it.
--
-- ADDITIVE AND INERT. One nullable column with no default: every existing zone
-- reads NULL ("no override") and every trip prices exactly as before until an
-- admin, or a fresh install's seed, sets a rate. A nullable column without a
-- default is a catalogue-only change on PostgreSQL 11+ (no table rewrite).
-- The CHECK holds the column to what the admin route accepts at its floor: a
-- whole, positive number of the market's currency, or NULL. "zones" holds a
-- handful of rows, so the constraint is validated in place.
--
-- ROLLBACK: rollback.sql in this directory (roll the application back first).
SET lock_timeout = '10s';
ALTER TABLE "zones" ADD COLUMN "taxiPerKm" DECIMAL(10,2);
ALTER TABLE "zones" ADD CONSTRAINT "zones_taxi_per_km_whole_positive"
  CHECK ("taxiPerKm" IS NULL OR ("taxiPerKm" > 0 AND "taxiPerKm" = trunc("taxiPerKm")));
