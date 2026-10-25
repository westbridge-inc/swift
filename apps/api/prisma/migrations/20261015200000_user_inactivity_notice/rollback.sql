-- ROLLBACK for 20261015200000_user_inactivity_notice (the inactive-account notice clock).
--
-- Roll the application back first: the previous application never reads this column. The
-- notice dates go with it; a person already told is told again (30 more days) once the
-- migration is applied again, never closed sooner.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "users" DROP COLUMN IF EXISTS "inactivityNoticeAt";
DO $ledger$ DECLARE n integer; BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261015200000_user_inactivity_notice';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
