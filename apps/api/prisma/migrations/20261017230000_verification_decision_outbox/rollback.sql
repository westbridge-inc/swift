-- [S2-29] Rollback of 20261017230000_verification_decision_outbox.
-- Refuses while an approval still owes its trial decision or a row is a dead letter: dropping
-- the table would silently drop that work. Drain or resolve those rows first. The table forces
-- row-level security, so run this as a role that bypasses it (a superuser or BYPASSRLS).
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "verification_decision_outbox" WHERE "processedAt" IS NULL) THEN
    RAISE EXCEPTION 'verification_decision_outbox still holds unprocessed rows; drain them before rolling back';
  END IF;
END $$;
DROP TABLE "verification_decision_outbox";
COMMIT;
