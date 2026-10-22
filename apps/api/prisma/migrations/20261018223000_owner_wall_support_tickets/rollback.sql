-- [item 20] Rollback of 20261018223000_owner_wall_support_tickets. Switch the
-- wall OFF first (OWNER_RLS_BIND unset, swift_owner_wall revoked from every
-- login), and deploy code that no longer calls the two functions.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION IF EXISTS public.swift_owner_wall_order_case_exists(text, text);
DROP FUNCTION IF EXISTS public.swift_owner_wall_close_order_case(text, text, text, text, text);
DROP POLICY IF EXISTS "owner_isolation" ON "support_tickets";
DROP POLICY IF EXISTS "owner_isolation_update" ON "support_tickets";
DROP POLICY IF EXISTS "owner_isolation_delete" ON "support_tickets";
DROP POLICY IF EXISTS "ticket_write" ON "support_tickets";
ALTER TABLE "support_tickets" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "support_tickets" DISABLE ROW LEVEL SECURITY;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261018223000_owner_wall_support_tickets';
COMMIT;
