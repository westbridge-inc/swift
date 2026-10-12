BEGIN;
-- Purge authority is isolated from request and worker logins. No membership is granted here.
-- Audit retention stays permanent unless a separately authorized operator is provisioned.
DO $roles$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['swift_audit_purge_owner', 'swift_audit_purge_executor'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', role_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name
      AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
      RAISE EXCEPTION 'audit purge role has unexpected privileges';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
             WHERE r.rolname = 'swift_audit_purge_owner') THEN
    RAISE EXCEPTION 'audit purge owner must not have members';
  END IF;
END $roles$;
GRANT USAGE ON SCHEMA public TO swift_audit_purge_owner, swift_audit_purge_executor;
GRANT SELECT ON public.audit_logs, public.sensitive_read_logs TO swift_audit_purge_executor;
GRANT SELECT, DELETE ON public.audit_logs, public.sensitive_read_logs TO swift_audit_purge_owner;

CREATE OR REPLACE FUNCTION public.audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_OP <> 'DELETE' OR current_user <> 'swift_audit_purge_owner' THEN
    RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $guard$;
CREATE POLICY audit_purge_owner_select ON public.audit_logs
  FOR SELECT TO swift_audit_purge_owner, swift_audit_purge_executor USING (true);
CREATE POLICY audit_purge_owner_delete ON public.audit_logs
  FOR DELETE TO swift_audit_purge_owner USING (true);

CREATE FUNCTION public.swift_purge_audit_logs(ids text[], reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $purge$
DECLARE removed integer;
BEGIN
  IF reason IS NULL OR length(btrim(reason)) < 8 THEN
    RAISE EXCEPTION 'an audit purge must name its reason (>= 8 chars)';
  END IF;
  IF ids IS NULL OR cardinality(ids) > 1000 THEN
    RAISE EXCEPTION 'an audit purge requires at most 1000 explicit ids';
  END IF;
  DELETE FROM public.audit_logs WHERE id = ANY(ids);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $purge$;
ALTER FUNCTION public.swift_purge_audit_logs(text[], text) OWNER TO swift_audit_purge_owner;
REVOKE ALL ON FUNCTION public.swift_purge_audit_logs(text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.swift_purge_audit_logs(text[], text) FROM swift_app;

CREATE OR REPLACE FUNCTION public.sensitive_read_logs_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_OP <> 'DELETE' OR current_user <> 'swift_audit_purge_owner' THEN
    RAISE EXCEPTION 'sensitive_read_logs is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $guard$;
CREATE POLICY audit_purge_owner_select ON public.sensitive_read_logs
  FOR SELECT TO swift_audit_purge_owner, swift_audit_purge_executor USING (true);
CREATE POLICY audit_purge_owner_delete ON public.sensitive_read_logs
  FOR DELETE TO swift_audit_purge_owner USING (true);

CREATE FUNCTION public.swift_purge_sensitive_read_logs(ids text[], reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $purge$
DECLARE removed integer;
BEGIN
  IF reason IS NULL OR length(btrim(reason)) < 8 THEN
    RAISE EXCEPTION 'an audit purge must name its reason (>= 8 chars)';
  END IF;
  IF ids IS NULL OR cardinality(ids) > 1000 THEN
    RAISE EXCEPTION 'an audit purge requires at most 1000 explicit ids';
  END IF;
  DELETE FROM public.sensitive_read_logs WHERE id = ANY(ids);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $purge$;
ALTER FUNCTION public.swift_purge_sensitive_read_logs(text[], text) OWNER TO swift_audit_purge_owner;
REVOKE ALL ON FUNCTION public.swift_purge_sensitive_read_logs(text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.swift_purge_sensitive_read_logs(text[], text) FROM swift_app;

-- TRUNCATE never qualifies as an explicit-id purge.
CREATE FUNCTION public.sensitive_read_logs_block_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $truncate$
BEGIN
  RAISE EXCEPTION 'sensitive_read_logs is append-only' USING ERRCODE = 'restrict_violation';
END $truncate$;
CREATE TRIGGER sensitive_read_logs_no_truncate BEFORE TRUNCATE ON public.sensitive_read_logs
FOR EACH STATEMENT EXECUTE FUNCTION public.sensitive_read_logs_block_truncate();

-- Creation defaults may grant EXECUTE to any application/tenant group, not just
-- PUBLIC or swift_app. Ownership changes preserve those ACLs: remove every
-- non-owner grant after CREATE, then grant only the dedicated executor.
DO $purge_acl$
DECLARE entry record;
BEGIN
  FOR entry IN
    SELECT DISTINCT p.oid::regprocedure AS signature, r.rolname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) acl
    JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'public'
      AND p.proname IN ('swift_purge_audit_logs', 'swift_purge_sensitive_read_logs')
      AND acl.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', entry.signature, entry.rolname);
  END LOOP;
END $purge_acl$;
GRANT EXECUTE ON FUNCTION public.swift_purge_audit_logs(text[], text) TO swift_audit_purge_executor;
GRANT EXECUTE ON FUNCTION public.swift_purge_sensitive_read_logs(text[], text) TO swift_audit_purge_executor;
COMMIT;
