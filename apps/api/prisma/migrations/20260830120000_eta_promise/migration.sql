-- [ALG-12 / FMC §12.2] The customer's ETA promise, written onto the order at
-- creation and never silently revised; the pad learned weekly from Swift's
-- own lateness per vertical and hour. Additive, nullable.
SET lock_timeout = '10s';

ALTER TABLE "orders" ADD COLUMN "promisedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "promiseBaseSeconds" INTEGER;
ALTER TABLE "orders" ADD COLUMN "promisePadSeconds" INTEGER;
ALTER TABLE "orders" ADD COLUMN "promiseRevisedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "promiseRevisionReason" TEXT;
ALTER TABLE "orders" ADD COLUMN "promiseRevisions" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "eta_pad_stats" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL DEFAULT 'swift-default',
    "vertical"       TEXT NOT NULL,
    "hourBucket"     INTEGER NOT NULL,
    "sampleCount"    INTEGER NOT NULL,
    "onTimeRate"     DOUBLE PRECISION NOT NULL,
    "padSeconds"     INTEGER NOT NULL,
    "lastComputedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eta_pad_stats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "eta_pad_stats_tenantId_vertical_hourBucket_key" ON "eta_pad_stats"("tenantId", "vertical", "hourBucket");

ALTER TABLE "eta_pad_stats" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "eta_pad_stats";
CREATE POLICY "tenant_isolation" ON "eta_pad_stats"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
