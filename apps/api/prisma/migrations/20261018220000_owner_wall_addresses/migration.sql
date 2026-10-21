-- [item 20 · owner wall] Saved addresses get a database wall of their own: a
-- request login sees only the rows of the person it acts for. INERT until
-- switched on (COORD 18 Oct): the policy admits every row to a login that is
-- not a member of swift_owner_wall, which no login is after this migration.
-- Switch-on (after a staging journey run): GRANT swift_owner_wall TO the
-- request login, and OWNER_RLS_BIND=1 so the app binds app.current_user beside
-- app.current_tenant. A walled login that binds no person sees ZERO rows.
-- The system login (a swift_bypass_rls member) is never walled.
SET lock_timeout = '10s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_owner_wall') THEN
    CREATE ROLE swift_owner_wall NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

ALTER TABLE "addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "addresses" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_isolation" ON "addresses";
CREATE POLICY "owner_isolation" ON "addresses"
  USING (pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
    OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER')
    OR "userId" = NULLIF(current_setting('app.current_user', true), ''))
  WITH CHECK (pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
    OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER')
    OR "userId" = NULLIF(current_setting('app.current_user', true), ''));
