-- [TA-S1-006] ServiceJob gains a DURABLE tenant identity for safety routing.
-- Additive: one column with the schema default (a metadata-only change on
-- PostgreSQL 11+), backfilled from the customer — the hiring party; creation
-- already asserts both parties share a tenant — one index, and the canonical
-- tenant wall (W-201) so one operator's jobs are never readable through
-- another's session. No existing column or row shape changes.
SET lock_timeout = '10s';

ALTER TABLE "service_jobs" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'swift-default';

-- Backfill: the job belongs to the tenant of the customer who hired.
UPDATE "service_jobs" sj
SET "tenantId" = u."tenantId"
FROM "users" u
WHERE u."id" = sj."customerId" AND sj."tenantId" IS DISTINCT FROM u."tenantId";

CREATE INDEX "service_jobs_tenantId_idx" ON "service_jobs"("tenantId");

-- [W-201] Tenant isolation, the canonical predicate (F-021-11): the bypass is
-- a ROLE, never a GUC a session could set on itself.
ALTER TABLE "service_jobs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "service_jobs";
CREATE POLICY "tenant_isolation" ON "service_jobs"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
