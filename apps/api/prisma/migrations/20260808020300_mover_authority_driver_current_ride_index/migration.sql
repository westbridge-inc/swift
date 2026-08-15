-- One statement by design; see the preceding online-index migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "drivers_currentRideId_idx"
ON "drivers"("currentRideId");
