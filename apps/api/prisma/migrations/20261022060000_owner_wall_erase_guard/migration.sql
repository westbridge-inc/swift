-- [row 622 · #1890 review S4-1] The owner wall's two account-erasure actions
-- (20261018221000 erase_devices, 20261018222000 erase_notices) trusted their
-- caller: any swift_app session could empty any person's push registrations
-- and inbox by id. They now refuse unless that person's account carries the
-- erasure tombstone, users.phone = 'deleted:' || id: the exact erasure marker
-- (a status alone can be replaced by a later ban). The account closure writes
-- that tombstone FIRST in its transaction, before it calls them; the re-sweep
-- of a closed account finds it committed.
--
-- Same shape as before: SECURITY DEFINER, run as their owner (the migration
-- owner), pinned search_path, schema-qualified tables, no dynamic SQL. CREATE OR REPLACE keeps
-- the owner and the grants; they are restated below. A refusal is loud
-- (insufficient_privilege) and rolls the caller's transaction back.
-- users has FORCE ROW LEVEL SECURITY: the guard sees the users rows the
-- caller's tenant binding shows (the same view the closure's FOR UPDATE of the
-- person's row already has, so it sees the tombstone written just before in
-- that transaction). A row it cannot see reads as not in erasure: it refuses,
-- never passes.
CREATE OR REPLACE FUNCTION public.swift_owner_wall_erase_devices(p_user_id text) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id AND u.phone = 'deleted:' || p_user_id) THEN
    RAISE EXCEPTION 'swift_owner_wall_erase_devices: the account is not in erasure' USING ERRCODE = 'insufficient_privilege';
  END IF;
  WITH erased AS (
    DELETE FROM public.device_tokens WHERE "userId" = p_user_id
    RETURNING 1)
  SELECT count(*)::integer INTO n FROM erased;
  RETURN n;
END
$$;
CREATE OR REPLACE FUNCTION public.swift_owner_wall_erase_notices(p_user_id text) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id AND u.phone = 'deleted:' || p_user_id) THEN
    RAISE EXCEPTION 'swift_owner_wall_erase_notices: the account is not in erasure' USING ERRCODE = 'insufficient_privilege';
  END IF;
  WITH erased AS (
    DELETE FROM public.notifications WHERE "userId" = p_user_id
    RETURNING 1)
  SELECT count(*)::integer INTO n FROM erased;
  RETURN n;
END
$$;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_erase_devices(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_erase_notices(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_erase_devices(text) TO swift_app;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_erase_notices(text) TO swift_app;
