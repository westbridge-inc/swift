-- ROLLBACK for 20261028230000_appointment_no_shows ("Customer didn't come", owner B3).
--
-- Forward repair is preferred. Roll the application back first: the previous application never reads this table.
-- The guard refuses while any row exists: each row is a missed-appointment record the Privacy Policy says Swift
-- keeps with its order.
BEGIN;
-- Row-level security is FORCED on this table: without this, a role that does not bypass it sees no rows, the
-- guard passes blind, and the data is dropped. With it, such a role gets an error instead.
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "appointment_no_shows") THEN
    RAISE EXCEPTION 'APPOINTMENT_NO_SHOWS_IN_USE: missed-appointment records would be lost; not rolling back';
  END IF;
END $guard$;
DROP TABLE "appointment_no_shows";
DROP FUNCTION appointment_no_shows_tenant_matches_order();
DO $ledger$
DECLARE n integer;
BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261028230000_appointment_no_shows';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
