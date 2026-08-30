-- [ALGO Band 0.3] The decision log. Additive: one new table, no existing
-- table or row changes. Every algorithm that ranks, prices, flags or gates
-- writes one row here — outcome, the one-sentence reason, the inputs and the
-- config version — so a decision can be appealed, debugged and audited from
-- the same place. Shadow rows carry what a not-yet-live algorithm WOULD have
-- decided; the worker purges them at 90 days and live rows at 400.
SET lock_timeout = '10s';

CREATE TABLE "algo_decisions" (
    "id"            TEXT NOT NULL,
    "tenantId"      TEXT NOT NULL DEFAULT 'swift-default',
    "algo"          TEXT NOT NULL,
    "subjectType"   TEXT NOT NULL,
    "subjectId"     TEXT NOT NULL,
    "outcome"       TEXT NOT NULL,
    "sentence"      TEXT NOT NULL,
    "inputs"        JSONB NOT NULL,
    "configVersion" INTEGER NOT NULL DEFAULT 0,
    "shadow"        BOOLEAN NOT NULL DEFAULT false,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "algo_decisions_pkey" PRIMARY KEY ("id")
);

-- The founder's question ("what did ALG-18 decide last week?") and the
-- appeal's question ("what was decided about THIS order?").
CREATE INDEX "algo_decisions_tenantId_algo_createdAt_idx" ON "algo_decisions"("tenantId", "algo", "createdAt");
CREATE INDEX "algo_decisions_subjectType_subjectId_idx" ON "algo_decisions"("subjectType", "subjectId");
-- Retention sweeps by age within each class.
CREATE INDEX "algo_decisions_shadow_createdAt_idx" ON "algo_decisions"("shadow", "createdAt");

-- [W-201] Tenant isolation, the canonical predicate (F-021-11): the bypass is
-- a ROLE, never a GUC a session could set on itself.
ALTER TABLE "algo_decisions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "algo_decisions";
CREATE POLICY "tenant_isolation" ON "algo_decisions"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
