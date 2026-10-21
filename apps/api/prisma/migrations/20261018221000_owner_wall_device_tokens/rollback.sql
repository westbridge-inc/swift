-- [item 20] Rollback of 20261018221000_owner_wall_device_tokens. Switch the
-- wall OFF first (OWNER_RLS_BIND unset, swift_owner_wall revoked from every
-- login), and deploy code that no longer calls the three functions.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION IF EXISTS public.swift_owner_wall_revoke_devices(text);
DROP FUNCTION IF EXISTS public.swift_owner_wall_revoke_device(text, text);
DROP FUNCTION IF EXISTS public.swift_owner_wall_erase_devices(text);
DROP POLICY IF EXISTS "owner_isolation" ON "device_tokens";
ALTER TABLE "device_tokens" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "device_tokens" DISABLE ROW LEVEL SECURITY;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261018221000_owner_wall_device_tokens';
COMMIT;
