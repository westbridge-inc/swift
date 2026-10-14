-- ROLLBACK for 20261014090000_taxi_ride_waiting (the taxi waiting charge).
--
-- Forward repair is preferred. Roll the application back first: the previous
-- application never reads this table. The guard refuses while any row exists:
-- a row holds the waiting terms a passenger was shown at booking and, once
-- frozen, the waiting charge they paid in cash, and both would be lost. While
-- TAXI_WAITING_CHARGE is off (the launch state) no row is ever written, so the
-- table is empty and this rolls back cleanly.
BEGIN;
-- Row-level security is FORCED on this table: without this, a role that does
-- not bypass it sees no rows, the guard passes blind, and the data is dropped.
-- With it, such a role gets an error instead.
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "taxi_ride_waiting") THEN
    RAISE EXCEPTION 'TAXI_WAITING_IN_USE: taxi rides carry waiting terms or charges that would be lost; not rolling back';
  END IF;
END $guard$;
DROP TABLE "taxi_ride_waiting";
DROP FUNCTION taxi_ride_waiting_frozen();
DROP FUNCTION taxi_ride_waiting_tenant_matches_order();
DO $ledger$ DECLARE n integer; BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261014090000_taxi_ride_waiting';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
