-- [ALGO Band 0.2] The versioned tunable store.
--
-- ADDITIVE ONLY: a new table, no column dropped, no default changed. Nothing
-- reads it until a constant is deliberately moved onto it, and every key's
-- default lives in code, so an EMPTY TABLE BEHAVES EXACTLY AS TODAY.
--
-- Rows are immutable versions of a key rather than editable settings: changing
-- a value inserts version N+1, and the value in force is the highest version.
-- That is what lets a decision recorded a year ago be re-explained with the
-- config that actually produced it.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

CREATE TABLE "algo_config" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "founderGated" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "algo_config_pkey" PRIMARY KEY ("id")
);

-- One row per (tenant, key, version): a version is written once and never
-- rewritten, so a concurrent double-write of the same version loses loudly
-- instead of silently overwriting an audited value.
CREATE UNIQUE INDEX "algo_config_tenantId_key_version_key"
    ON "algo_config"("tenantId", "key", "version");

-- The hot read: newest version of one key for one tenant.
CREATE INDEX "algo_config_tenantId_key_version_idx"
    ON "algo_config"("tenantId", "key", "version");

-- [ELV-1 W-201] Tenant isolation, same shape as every other tenant-bearing
-- table. ENABLE (not FORCE) — the app connects as table owner and is
-- unaffected until the deliberate CONTRACT stage; the predicate fails CLOSED
-- without tenant context.
ALTER TABLE "algo_config" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "algo_config";
CREATE POLICY "tenant_isolation" ON "algo_config"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
