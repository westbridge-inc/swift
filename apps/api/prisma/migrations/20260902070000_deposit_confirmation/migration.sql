-- [M-22] A bank deposit confirmation is an immutable record; corrections are
-- separate adjustment records. Additive: one new table with tenant isolation.
SET lock_timeout = '10s';

CREATE TABLE "deposit_confirmations" (
    "id"           TEXT NOT NULL,
    "tenantId"     TEXT NOT NULL DEFAULT 'swift-default',
    "batchId"      TEXT NOT NULL,
    "provider"     TEXT NOT NULL DEFAULT 'MMG',
    "kind"         TEXT NOT NULL,
    "supersedesId" TEXT,
    "depositedGyd" DECIMAL(12,2) NOT NULL,
    "depositedAt"  TIMESTAMP(3) NOT NULL,
    "bankRef"      TEXT NOT NULL,
    "status"       TEXT NOT NULL,
    "deltaGyd"     DECIMAL(12,2) NOT NULL,
    "reason"       TEXT,
    "confirmedBy"  TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_confirmations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "deposit_confirmations_tenantId_provider_bankRef_key" ON "deposit_confirmations"("tenantId", "provider", "bankRef");
CREATE INDEX "deposit_confirmations_batchId_createdAt_idx" ON "deposit_confirmations"("batchId", "createdAt");

-- [W-201] Tenant isolation, the canonical predicate (F-021-11): the bypass is
-- a ROLE, never a GUC a session could set on itself.
ALTER TABLE "deposit_confirmations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "deposit_confirmations";
CREATE POLICY "tenant_isolation" ON "deposit_confirmations"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
