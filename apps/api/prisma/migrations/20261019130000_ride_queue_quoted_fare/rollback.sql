-- ROLLBACK for 20261019130000_ride_queue_quoted_fare.
--
-- Roll the application back first: the previous application never reads the
-- column. Dropping it forgets the fare each waiting passenger was shown, so the
-- scan books their rides at the fare of the moment again (the behaviour before
-- the lock). Queue entries live minutes, so forward repair is simple: re-apply
-- the migration (this file removes its ledger row, so `migrate deploy` applies
-- it again); passengers who join after that are locked again. No row-level
-- guard is needed: no money or evidence is lost, only a quote.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "ride_queue_entries" DROP CONSTRAINT IF EXISTS "ride_queue_entries_quoted_fare_whole";
ALTER TABLE "ride_queue_entries" DROP COLUMN IF EXISTS "quotedFare";
DO $ledger$ DECLARE n integer; BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261019130000_ride_queue_quoted_fare';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
