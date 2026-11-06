-- ROLLBACK for 20261106100000_call_sessions_in_app (in-app calling's RINGING_APP state).
--
-- Roll the application back first. Refuses while any row is RINGING_APP (a call ringing in someone's
-- app right now). Rows that ended (CONNECTED / NOT_CONNECTED) already satisfy the old CHECK and stay.
BEGIN;
-- Row-level security is FORCED on this table: read past it, or the guard passes blind.
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "call_sessions" WHERE "status" = 'RINGING_APP') THEN
    RAISE EXCEPTION 'CALL_SESSIONS_RINGING_APP: an in-app call is ringing; not rolling back';
  END IF;
END $guard$;
ALTER TABLE "call_sessions" DROP CONSTRAINT "call_sessions_status_check";
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_status_check"
  CHECK ("status" IN ('DIALING_CALLER', 'CALLER_CONFIRMED', 'CONNECTED', 'NOT_CONNECTED', 'FAILED'));
DO $ledger$
DECLARE n integer;
BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106100000_call_sessions_in_app';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
