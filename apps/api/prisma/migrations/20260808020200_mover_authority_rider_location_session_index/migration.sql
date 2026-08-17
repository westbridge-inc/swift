-- One statement by design; see the preceding online-index migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "riders_locationSessionId_idx"
ON "riders"("locationSessionId");
