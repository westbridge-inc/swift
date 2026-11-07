-- ROLLBACK for 20261025090000_call_sessions (the Swift call bridge).
--
-- Forward repair is preferred. Roll the application back first: the previous
-- application never reads this table. The guard refuses while any row exists:
-- each row is a call Swift placed (and paid for) on someone's order. While
-- CALL_RELAY is off (the launch state) no row is ever written, so the table is
-- empty and this rolls back cleanly.
BEGIN;
-- Row-level security is FORCED on this table: without this, a role that does
-- not bypass it sees no rows, the guard passes blind, and the data is dropped.
-- With it, such a role gets an error instead.
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "call_sessions") THEN
    RAISE EXCEPTION 'CALL_SESSIONS_IN_USE: the call bridge has placed calls that would be lost; not rolling back';
  END IF;
END $guard$;
DROP TABLE "call_sessions";
DROP FUNCTION call_sessions_tenant_matches_order();
DO $ledger$
DECLARE n integer;
BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261025090000_call_sessions';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
