-- ROLLBACK for 20261029041000_branch_person_approval (a branch waits for a person, COORD ruling 29 Oct 2026).
-- Roll the application back first. Refuses while any store is still waiting for a person to approve it.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "vendors" WHERE "personApprovalRequired") THEN
    RAISE EXCEPTION 'BRANCHES_WAITING_FOR_A_PERSON: a branch still waits for approval; not rolling back';
  END IF;
END $guard$;
ALTER TABLE "vendors" DROP COLUMN "personApprovalRequired";
DO $ledger$
DECLARE n integer;
BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029041000_branch_person_approval';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
