-- [item 20 · owner wall] Support tickets are walled to their person, the same
-- way as the inbox (20261018222000): INERT until the request login is granted
-- swift_owner_wall and OWNER_RLS_BIND=1.
--  - owner_isolation (SELECT), owner_isolation_update (UPDATE),
--    owner_isolation_delete (DELETE): a ticket is its person's;
--  - ticket_write (INSERT) WITH CHECK (true): a case may be opened FOR a
--    person (the MMG store-silent sweep opens one for the customer). A write
--    for someone else goes through ONE app helper (lib/owner-wall-tickets
--    insertTicketFor): an INSERT with an app-generated id and no RETURNING.
-- Support staff read and answer the queue through a named capability (the
-- system login) with the tenant boundary they always had.
--
-- Inside a transaction, the two things a transaction does to SOMEONE ELSE'S
-- ticket (is the order's store-silent MMG case open; close it when the store
-- taps "Paid by MMG" or the order cancels) call ONE narrow SECURITY DEFINER
-- function each, keyed by the order and the case's subject. They run as their
-- owner, with a pinned search_path and schema-qualified names, no dynamic SQL,
-- EXECUTE revoked from PUBLIC and granted to swift_app only. Authorization
-- stays in the app callers (owner-wall-support-tickets census pins them).
SET lock_timeout = '10s';

ALTER TABLE "support_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_tickets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_isolation" ON "support_tickets";
DROP POLICY IF EXISTS "owner_isolation_update" ON "support_tickets";
DROP POLICY IF EXISTS "owner_isolation_delete" ON "support_tickets";
DROP POLICY IF EXISTS "ticket_write" ON "support_tickets";
CREATE POLICY "owner_isolation" ON "support_tickets" FOR SELECT
  USING (pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
    OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER')
    OR "userId" = NULLIF(current_setting('app.current_user', true), ''));
CREATE POLICY "owner_isolation_update" ON "support_tickets" FOR UPDATE
  USING (pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
    OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER')
    OR "userId" = NULLIF(current_setting('app.current_user', true), ''))
  WITH CHECK (pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
    OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER')
    OR "userId" = NULLIF(current_setting('app.current_user', true), ''));
CREATE POLICY "owner_isolation_delete" ON "support_tickets" FOR DELETE
  USING (pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
    OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER')
    OR "userId" = NULLIF(current_setting('app.current_user', true), ''));
CREATE POLICY "ticket_write" ON "support_tickets" FOR INSERT WITH CHECK (true);

-- Is a PAYMENT case with this subject already open for the order (any status)?
CREATE OR REPLACE FUNCTION public.swift_owner_wall_order_case_exists(p_order_id text, p_subject text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.support_tickets t
   WHERE t."orderId" = p_order_id AND t.category = 'PAYMENT'::public."SupportCategory" AND t.subject = p_subject)
$$;
-- Close the order's PAYMENT case with this subject that is still OPEN or
-- IN_PROGRESS: RESOLVED, ACTION_TAKEN, with the note and the times given.
-- Returns how many.
CREATE OR REPLACE FUNCTION public.swift_owner_wall_close_order_case(p_order_id text, p_subject text, p_note text, p_resolved_at text, p_updated_at text)
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH closed AS (
    UPDATE public.support_tickets t
       SET status = 'RESOLVED'::public."SupportStatus",
           resolution = 'ACTION_TAKEN'::public."SupportResolution",
           "resolvedAt" = (p_resolved_at::timestamptz AT TIME ZONE 'UTC'),
           "adminNote" = p_note,
           "updatedAt" = (p_updated_at::timestamptz AT TIME ZONE 'UTC')
     WHERE t."orderId" = p_order_id AND t.category = 'PAYMENT'::public."SupportCategory" AND t.subject = p_subject
       AND t.status IN ('OPEN'::public."SupportStatus", 'IN_PROGRESS'::public."SupportStatus")
    RETURNING 1)
  SELECT count(*)::integer FROM closed
$$;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_order_case_exists(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.swift_owner_wall_close_order_case(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_order_case_exists(text, text) TO swift_app;
GRANT EXECUTE ON FUNCTION public.swift_owner_wall_close_order_case(text, text, text, text, text) TO swift_app;
