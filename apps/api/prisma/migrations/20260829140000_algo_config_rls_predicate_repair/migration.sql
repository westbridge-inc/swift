-- [F-021-11 repair] One table on the tenant wall was carrying the predicate the
-- wall deliberately stopped using.
--
-- `20260828120000_algo_config` installed its tenant_isolation policy by copying
-- the DDL text out of an older migration instead of the predicate that
-- `rlsDdlFor()` in src/lib/tenant-rls.ts now emits. That older text bypasses on
-- a GUC:
--
--     OR current_setting('app.bypass_tenant', true) = 'on'
--
-- REPORT-021 F-021-11 is the reason that form was retired: a GUC is settable by
-- the very role the wall constrains, so `SET app.bypass_tenant = 'on'` — from
-- application code or through any SQL-injection foothold — lifts the wall for
-- that table. The replacement is a ROLE CAPABILITY, which a constrained role
-- cannot grant itself:
--
--     OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
--
-- Measured, not reasoned: of the 53 walled tables, 52 carried the role form and
-- `algo_config` alone carried the GUC form. It holds the versioned algorithm
-- tunables, `founderGated` rows among them, so it is the one table where a
-- cross-tenant write silently changes how another operator's platform decides.
--
-- Nothing else changes: same policy name, same table, same rows. This is the
-- expand-stage shape (ENABLE, not FORCE) exactly as every sibling table, so
-- behaviour today is identical and the CONTRACT stage no longer has a hole to
-- inherit.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "algo_config" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "algo_config";
CREATE POLICY "tenant_isolation" ON "algo_config"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
