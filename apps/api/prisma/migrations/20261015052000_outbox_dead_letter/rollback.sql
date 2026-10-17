-- [row 267] Rollback of 20261015052000_outbox_dead_letter.
-- Refuses while any row is a dead letter: dropping the stamp would hand the
-- previous application a row it retries for ever, and lose what ops was told.
-- Requeue or resolve those rows first. order_outbox and rating_outbox force
-- row-level security, so the guard switches it off for this transaction: run
-- this as a role that bypasses row-level security (a superuser or BYPASSRLS).
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "order_outbox" WHERE "deadLetteredAt" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM "mover_revocation_outbox" WHERE "deadLetteredAt" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM "rating_outbox" WHERE "deadLetteredAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'OUTBOX_DEAD_LETTERS_PRESENT: requeue or resolve the dead-lettered outbox rows first; not rolling back';
  END IF;
END $$;
ALTER TABLE "order_outbox" DROP COLUMN "maxAttempts", DROP COLUMN "deadLetteredAt";
ALTER TABLE "mover_revocation_outbox" DROP COLUMN "maxAttempts", DROP COLUMN "deadLetteredAt";
ALTER TABLE "rating_outbox" DROP COLUMN "maxAttempts", DROP COLUMN "deadLetteredAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261015052000_outbox_dead_letter';
COMMIT;
