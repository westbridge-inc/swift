-- [item 20 · owner wall] The in-app inbox (notifications) is walled to its
-- person, like addresses (20261018220000) and push registrations
-- (20261018221000): INERT until the request login is granted swift_owner_wall
-- and OWNER_RLS_BIND=1.
--
-- Unlike those, almost every notice is written FOR SOMEONE ELSE (a store
-- tells its customer, an admin pages a rider). Writing a notice leaks nothing
-- and is the product, so the wall splits by command:
--  - owner_isolation (SELECT), owner_isolation_update (UPDATE),
--    owner_isolation_delete (DELETE): the inbox is its person's only;
--  - notice_write (INSERT) WITH CHECK (true): anyone may hand a person a notice.
-- Postgres applies the SELECT policy to INSERT ... RETURNING (Prisma's create
-- and upsert always return the row), so a cross-person write goes through ONE
-- app helper (lib/owner-wall-notices insertNoticeFor/upsertNoticeFor): an
-- INSERT with an app-generated id and no RETURNING.
--
-- Inside a transaction a query never changes connection, so the few reads and
-- updates a transaction makes on SOMEONE ELSE'S notices call ONE narrow
-- SECURITY DEFINER function each, keyed by the person they act on. They run as
-- their owner (the table owner, never a swift_owner_wall member, so the
-- policies are inert for it), with a pinned search_path and schema-qualified
-- tables, no dynamic SQL, EXECUTE revoked from PUBLIC and granted to swift_app
-- only. Authorization stays in the app callers (owner-wall-notifications test
-- census pins them).
SET lock_timeout = '10s';

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_isolation" ON "notifications";
DROP POLICY IF EXISTS "owner_isolation_update" ON "notifications";
DROP POLICY IF EXISTS "owner_isolation_delete" ON "notifications";
DROP POLICY IF EXISTS "notice_write" ON "notifications";
CREATE POLICY "owner_isolation" ON "notifications" FOR SELECT
  USING (pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
    OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER')
    OR "userId" = NULLIF(current_setting('app.current_user', true), ''));
CREATE POLICY "owner_isolation_update" ON "notifications" FOR UPDATE
  USING (pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
    OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER')
    OR "userId" = NULLIF(current_setting('app.current_user', true), ''))
  WITH CHECK (pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
    OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER')
    OR "userId" = NULLIF(current_setting('app.current_user', true), ''));
CREATE POLICY "owner_isolation_delete" ON "notifications" FOR DELETE
  USING (pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
    OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER')
    OR "userId" = NULLIF(current_setting('app.current_user', true), ''));
CREATE POLICY "notice_write" ON "notifications" FOR INSERT WITH CHECK (true);

-- The id of one person's notice with one dedupe key, or NULL: the read-back
-- of an idempotent write (upsertNoticeFor) that found the notice already there.
CREATE OR REPLACE FUNCTION public.swift_owner_wall_notice_id(p_user_id text, p_dedupe_key text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT n.id FROM public.notifications n WHERE n."userId" = p_user_id AND n."dedupeKey" = p_dedupe_key
$$;
-- One person's PENDING staff invites from one store (a new invite's
-- already-invited check, under the grant lock).
CREATE OR REPLACE FUNCTION public.swift_owner_wall_pending_staff_invites(p_user_id text, p_vendor_id text)
  RETURNS TABLE (id text, data jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT n.id, n.data FROM public.notifications n
   WHERE n."userId" = p_user_id
     AND n.data -> 'kind' = '"staff_invite"'::jsonb
     AND n.data -> 'state' = '"PENDING"'::jsonb
     AND n.data -> 'vendorId' = to_jsonb(p_vendor_id)
$$;
-- Close one person's PENDING staff invites from one store (acceptance,
-- removal from the team, the owner's withdrawal), except one. Returns how many.
CREATE OR REPLACE FUNCTION public.swift_owner_wall_close_staff_invites(p_user_id text, p_vendor_id text, p_decided_at text, p_except_id text)
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH closed AS (
    UPDATE public.notifications n
       SET "isRead" = true,
           "readAt" = (p_decided_at::timestamptz AT TIME ZONE 'UTC'),
           data = n.data || jsonb_build_object('state', 'CLOSED', 'decidedAt', p_decided_at)
     WHERE n."userId" = p_user_id
       AND n.data -> 'kind' = '"staff_invite"'::jsonb
       AND n.data -> 'state' = '"PENDING"'::jsonb
       AND n.data -> 'vendorId' = to_jsonb(p_vendor_id)
       AND n.id IS DISTINCT FROM p_except_id
    RETURNING 1)
  SELECT count(*)::integer FROM closed
$$;
-- The people holding a PENDING staff invite from one store written since a
-- time (the owner's withdrawal: who to lock and close). Ids only.
CREATE OR REPLACE FUNCTION public.swift_owner_wall_staff_invitees(p_vendor_id text, p_since text) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT n."userId" FROM public.notifications n
   WHERE n."createdAt" >= (p_since::timestamptz AT TIME ZONE 'UTC')
     AND n.data -> 'kind' = '"staff_invite"'::jsonb
     AND n.data -> 'state' = '"PENDING"'::jsonb
     AND n.data -> 'vendorId' = to_jsonb(p_vendor_id)
$$;
-- Has this person already been asked to publish a number customers can call
-- for this store (the go-live projection's once-per-store notice)?
CREATE OR REPLACE FUNCTION public.swift_owner_wall_public_phone_asked(p_user_id text, p_vendor_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.notifications n
   WHERE n."userId" = p_user_id
     AND n.data -> 'kind' = '"vendor_needs_public_phone"'::jsonb
     AND n.data -> 'vendorId' = to_jsonb(p_vendor_id))
$$;
-- [#1905 erasure] The account erasure removes the person's notices from inside its own transaction, run by
-- the person, an admin completing a closure, or the retry sweep: under the wall a plain DELETE by anyone but
-- the person would silently remove nothing. Keyed by the erased person; the caller holds the users row lock.
CREATE OR REPLACE FUNCTION public.swift_owner_wall_erase_notices(p_user_id text) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH erased AS (
    DELETE FROM public.notifications WHERE "userId" = p_user_id
    RETURNING 1)
  SELECT count(*)::integer FROM erased
$$;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_notice_id(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_pending_staff_invites(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_close_staff_invites(text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_staff_invitees(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_public_phone_asked(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_erase_notices(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_notice_id(text, text) TO swift_app;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_pending_staff_invites(text, text) TO swift_app;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_close_staff_invites(text, text, text, text) TO swift_app;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_staff_invitees(text, text) TO swift_app;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_public_phone_asked(text, text) TO swift_app;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_erase_notices(text) TO swift_app;
