-- [ALG-03 / FMC Movement 12] The prep-time learner's learned distribution of
-- acceptedAt → readyAt per vendor, per day-of-week and hour bucket. Recomputed
-- nightly; read only by the shadow predictor until the promotion gate passes.
SET lock_timeout = '10s';

CREATE TABLE "vendor_prep_stats" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL DEFAULT 'swift-default',
    "scope"          TEXT NOT NULL DEFAULT 'BUCKET',
    "vendorId"       TEXT NOT NULL,
    "dayOfWeek"      INTEGER NOT NULL,
    "hourBucket"     INTEGER NOT NULL,
    "sampleCount"    INTEGER NOT NULL,
    "outlierCount"   INTEGER NOT NULL DEFAULT 0,
    "medianItems"    INTEGER NOT NULL DEFAULT 1,
    "p50Seconds"     INTEGER NOT NULL,
    "p80Seconds"     INTEGER NOT NULL,
    "p95Seconds"     INTEGER NOT NULL,
    "lastComputedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_prep_stats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vendor_prep_stats_tenantId_vendorId_dayOfWeek_hourBucket_key" ON "vendor_prep_stats"("tenantId", "vendorId", "dayOfWeek", "hourBucket");
CREATE INDEX "vendor_prep_stats_vendorId_idx" ON "vendor_prep_stats"("vendorId");

ALTER TABLE "vendor_prep_stats" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "vendor_prep_stats";
CREATE POLICY "tenant_isolation" ON "vendor_prep_stats"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
