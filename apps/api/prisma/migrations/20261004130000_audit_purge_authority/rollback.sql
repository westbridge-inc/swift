-- Operator-only rollback: restores the legacy GUC guard, including its old authority.
-- Set swift.audit_purge_rollback = 'restore-legacy-guard' only after rolling back callers.
BEGIN;
LOCK TABLE public.audit_logs, public.sensitive_read_logs IN ACCESS EXCLUSIVE MODE;
DO $guard$
BEGIN
  IF current_setting('swift.audit_purge_rollback', true) IS DISTINCT FROM 'restore-legacy-guard' THEN
    RAISE EXCEPTION 'AUDIT_PURGE_ROLLBACK_REQUIRES_LEGACY_GUARD_ACK';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
    WHERE r.rolname IN ('swift_audit_purge_owner', 'swift_audit_purge_executor')) THEN
    RAISE EXCEPTION 'AUDIT_PURGE_ROLLBACK_REVOKE_MEMBERSHIPS_FIRST';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('swift_purge_audit_logs', 'swift_purge_sensitive_read_logs')
      AND pg_get_userbyid(p.proowner) <> 'swift_audit_purge_owner') THEN
    RAISE EXCEPTION 'AUDIT_PURGE_ROLLBACK_UNEXPECTED_FUNCTION_OWNER';
  END IF;
END $guard$;
DROP TRIGGER sensitive_read_logs_no_truncate ON public.sensitive_read_logs;
DROP FUNCTION public.sensitive_read_logs_block_truncate();
DROP FUNCTION public.swift_purge_audit_logs(text[], text);
DROP FUNCTION public.swift_purge_sensitive_read_logs(text[], text);
DROP POLICY audit_purge_owner_select ON public.audit_logs;
DROP POLICY audit_purge_owner_delete ON public.audit_logs;
DROP POLICY audit_purge_owner_select ON public.sensitive_read_logs;
DROP POLICY audit_purge_owner_delete ON public.sensitive_read_logs;

CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    RAISE EXCEPTION 'audit_logs is append-only — row % cannot be modified', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF coalesce(current_setting('swift.audit_purge', true), '') = '' THEN
    RAISE EXCEPTION 'audit_logs is append-only — row % cannot be deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
ALTER FUNCTION public.audit_logs_append_only() RESET ALL;

CREATE OR REPLACE FUNCTION sensitive_read_logs_append_only() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    RAISE EXCEPTION 'sensitive_read_logs is append-only — row % cannot be modified', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF coalesce(current_setting('swift.audit_purge', true), '') = '' THEN
    RAISE EXCEPTION 'sensitive_read_logs is append-only — row % cannot be deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
ALTER FUNCTION public.sensitive_read_logs_append_only() RESET ALL;

REVOKE SELECT, DELETE ON public.audit_logs, public.sensitive_read_logs FROM swift_audit_purge_owner;
REVOKE SELECT ON public.audit_logs, public.sensitive_read_logs FROM swift_audit_purge_executor;
REVOKE USAGE ON SCHEMA public FROM swift_audit_purge_owner, swift_audit_purge_executor;
-- Roles are cluster-wide: drop only when no other database/object depends on them.
-- A shared pre-existing NOLOGIN role is preserved, with this database's grants removed.
DO $roles$
DECLARE role_name text; role_oid oid;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['swift_audit_purge_owner', 'swift_audit_purge_executor'] LOOP
    SELECT oid INTO role_oid FROM pg_roles WHERE rolname = role_name;
    IF NOT EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = role_oid) THEN
      EXECUTE format('DROP ROLE %I', role_name);
    ELSE
      RAISE NOTICE 'preserving shared role %, local purge grants revoked', role_name;
    END IF;
  END LOOP;
END $roles$;
COMMIT;
