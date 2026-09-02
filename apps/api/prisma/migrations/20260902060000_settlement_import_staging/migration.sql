-- [M-20] A settlement file is one staged import, validated in full before any
-- row may publish money. Additive: one new table with tenant isolation.
SET lock_timeout = '10s';

CREATE TABLE "settlement_imports" (
    "id"            TEXT NOT NULL,
    "tenantId"      TEXT NOT NULL DEFAULT 'swift-default',
    "source"        TEXT NOT NULL,
    "fileHash"      TEXT NOT NULL,
    "rowCount"      INTEGER NOT NULL,
    "computedTotal" DECIMAL(14,2) NOT NULL,
    "controlTotal"  DECIMAL(14,2),
    "status"        TEXT NOT NULL DEFAULT 'STAGED',
    "rejectReasons" JSONB,
    "rows"          JSONB NOT NULL,
    "results"       JSONB,
    "credited"      INTEGER NOT NULL DEFAULT 0,
    "publishedAt"   TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_imports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "settlement_imports_tenantId_fileHash_key" ON "settlement_imports"("tenantId", "fileHash");
CREATE INDEX "settlement_imports_status_createdAt_idx" ON "settlement_imports"("status", "createdAt");

-- [W-201] Tenant isolation, the canonical predicate (F-021-11): the bypass is
-- a ROLE, never a GUC a session could set on itself.
ALTER TABLE "settlement_imports" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "settlement_imports";
CREATE POLICY "tenant_isolation" ON "settlement_imports"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
