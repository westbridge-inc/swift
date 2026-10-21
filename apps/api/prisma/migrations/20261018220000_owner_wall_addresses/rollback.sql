-- [item 20] Rollback of 20261018220000_owner_wall_addresses. Switch the wall
-- OFF first (OWNER_RLS_BIND unset, REVOKE swift_owner_wall from every login),
-- then drop the policy and row security. The role is kept when any login is
-- still a member (it is server-wide; drop it by hand once none is).
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP POLICY IF EXISTS "owner_isolation" ON "addresses";
ALTER TABLE "addresses" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "addresses" DISABLE ROW LEVEL SECURITY;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261018220000_owner_wall_addresses';
COMMIT;
