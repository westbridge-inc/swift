-- [F-021-25] bounded lock waits: RLS DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';
-- [REPORT-021 F-021-11] The bypass must be a ROLE CAPABILITY, not a GUC any
-- constrained role can set on itself. swift_bypass_rls is NOLOGIN, granted
-- ONLY to the owner-side maintenance identity (never to swift_app); the
-- policy predicate checks membership. Sanctioned cross-tenant work runs
-- under an identity holding this role — un-grantable from inside swift_app.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_bypass_rls') THEN
    CREATE ROLE swift_bypass_rls NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- Re-create every tenant_isolation policy with the role-membership bypass.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_policy p ON p.polrelid = c.oid
           WHERE n.nspname = 'public' AND p.polname = 'tenant_isolation'
  LOOP
    EXECUTE format('DROP POLICY "tenant_isolation" ON %I', t);
    EXECUTE format($f$CREATE POLICY "tenant_isolation" ON %I
      USING ("tenantId" = current_setting('app.current_tenant', true)
        OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'))
      WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)
        OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'))$f$, t);
  END LOOP;
END $$;

-- [REPORT-021 F-021-07] TRUNCATE does not fire row triggers: deny it outright
-- and trip a statement-level trigger as the second wall. (Owner DDL remains
-- possible by definition — contained by CONTRACT's non-owner runtime role.)
REVOKE TRUNCATE ON "consent_records" FROM PUBLIC;
CREATE OR REPLACE FUNCTION consent_records_block_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_records is append-only (DCR-1 NR-1). TRUNCATE is denied.';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS consent_records_no_truncate ON "consent_records";
CREATE TRIGGER consent_records_no_truncate
  BEFORE TRUNCATE ON "consent_records"
  FOR EACH STATEMENT EXECUTE FUNCTION consent_records_block_truncate();
