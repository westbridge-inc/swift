-- [item 20] Rollback of 20261018222000_owner_wall_notifications. Switch the
-- wall OFF first (OWNER_RLS_BIND unset, swift_owner_wall revoked from every
-- login), and deploy code that no longer calls the six functions.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION IF EXISTS public.swift_owner_wall_notice_id(text, text);
DROP FUNCTION IF EXISTS public.swift_owner_wall_pending_staff_invites(text, text);
DROP FUNCTION IF EXISTS public.swift_owner_wall_close_staff_invites(text, text, text, text);
DROP FUNCTION IF EXISTS public.swift_owner_wall_staff_invitees(text, text);
DROP FUNCTION IF EXISTS public.swift_owner_wall_public_phone_asked(text, text);
DROP FUNCTION IF EXISTS public.swift_owner_wall_erase_notices(text);
DROP POLICY IF EXISTS "owner_isolation" ON "notifications";
DROP POLICY IF EXISTS "owner_isolation_update" ON "notifications";
DROP POLICY IF EXISTS "owner_isolation_delete" ON "notifications";
DROP POLICY IF EXISTS "notice_write" ON "notifications";
ALTER TABLE "notifications" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "notifications" DISABLE ROW LEVEL SECURITY;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261018222000_owner_wall_notifications';
COMMIT;
