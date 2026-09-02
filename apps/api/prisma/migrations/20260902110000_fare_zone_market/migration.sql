-- [M-34] Fare zones are one operator's, in one market. Every zone gets an
-- owner (backfilled to the default tenant and GY — the only market that
-- exists), a priority for deterministic precedence, and a version. The zone
-- table joins the tenant wall (row-level security, the canonical predicate).
-- Additive; existing rows keep pricing exactly as before.
SET lock_timeout = '10s';

ALTER TABLE "zones" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'swift-default';
ALTER TABLE "zones" ADD COLUMN "countryCode" TEXT NOT NULL DEFAULT 'GY';
ALTER TABLE "zones" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "zones" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "zones" ADD CONSTRAINT "zones_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "zones_tenantId_countryCode_isActive_idx" ON "zones"("tenantId", "countryCode", "isActive");

-- [W-201] Tenant isolation, the canonical predicate (F-021-11): the bypass is
-- a ROLE, never a GUC a session could set on itself.
ALTER TABLE "zones" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "zones";
CREATE POLICY "tenant_isolation" ON "zones"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
