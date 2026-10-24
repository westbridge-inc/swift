-- [item 20 · owner wall] Push registrations (device tokens) are walled to
-- their person, exactly as addresses (20261018220000): INERT until the
-- request login is granted swift_owner_wall and OWNER_RLS_BIND=1.
--
-- Five writes act for ANOTHER person inside a transaction (an admin's ban,
-- session revocations, an account erasure). A transaction never changes
-- connection, so they cannot move to the system login: with the wall on they
-- would touch none of the target's rows, silently. Each calls ONE narrow
-- SECURITY DEFINER function instead, keyed by the user id it acts on. They
-- run as their owner (the table owner, never a swift_owner_wall member, so
-- the policy is inert for it), with a pinned search_path and schema-qualified
-- tables, no dynamic SQL, EXECUTE revoked from PUBLIC and granted to swift_app
-- only. Authorization stays in the app callers (owner-wall-device-tokens test
-- census: exactly those five call sites).
SET lock_timeout = '10s';

ALTER TABLE "device_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "device_tokens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_isolation" ON "device_tokens";
CREATE POLICY "owner_isolation" ON "device_tokens"
  USING (pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
    OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER')
    OR "userId" = NULLIF(current_setting('app.current_user', true), ''))
  WITH CHECK (pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
    OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER')
    OR "userId" = NULLIF(current_setting('app.current_user', true), ''));

-- Silence every active registration of one person (a ban, logout-all, a reset,
-- the end of other sessions). Returns how many were silenced.
CREATE OR REPLACE FUNCTION public.swift_owner_wall_revoke_devices(p_user_id text) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH revoked AS (
    UPDATE public.device_tokens SET "isActive" = false
     WHERE "userId" = p_user_id AND "isActive" = true
    RETURNING 1)
  SELECT count(*)::integer FROM revoked
$$;
-- Silence one registration of one person (a single session's revocation).
CREATE OR REPLACE FUNCTION public.swift_owner_wall_revoke_device(p_user_id text, p_token text) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH revoked AS (
    UPDATE public.device_tokens SET "isActive" = false
     WHERE "userId" = p_user_id AND token = p_token
    RETURNING 1)
  SELECT count(*)::integer FROM revoked
$$;
-- Delete every registration of one person (the account erasure).
CREATE OR REPLACE FUNCTION public.swift_owner_wall_erase_devices(p_user_id text) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH erased AS (
    DELETE FROM public.device_tokens WHERE "userId" = p_user_id
    RETURNING 1)
  SELECT count(*)::integer FROM erased
$$;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_revoke_devices(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_revoke_device(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_erase_devices(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_revoke_devices(text) TO swift_app;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_revoke_device(text, text) TO swift_app;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_erase_devices(text) TO swift_app;
