-- [row 622] Rollback of 20261022060000_owner_wall_erase_guard: the two erase
-- actions go back to their unguarded bodies (20261018221000, 20261018222000),
-- owner and grants unchanged. Code that writes the tombstone first stays valid.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION public.swift_owner_wall_erase_devices(p_user_id text) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH erased AS (
    DELETE FROM public.device_tokens WHERE "userId" = p_user_id
    RETURNING 1)
  SELECT count(*)::integer FROM erased
$$;
CREATE OR REPLACE FUNCTION public.swift_owner_wall_erase_notices(p_user_id text) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH erased AS (
    DELETE FROM public.notifications WHERE "userId" = p_user_id
    RETURNING 1)
  SELECT count(*)::integer FROM erased
$$;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_erase_devices(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_erase_notices(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_erase_devices(text) TO swift_app;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_erase_notices(text) TO swift_app;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261022060000_owner_wall_erase_guard';
COMMIT;
