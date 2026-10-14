-- [OWNER #13] Guarded rollback: the solo columns are the record of how an
-- approval was given. They are removed only when no request ever went solo;
-- otherwise this refuses, and the record stays.
-- privileged_approvals forces row-level security, so a role that sees only
-- some rows could find no solo request and pass the guard. Row security is
-- switched off for this transaction: a role that does not bypass it is refused
-- with an error instead. Run this as a role that bypasses row-level security
-- (a superuser or BYPASSRLS).
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "privileged_approvals" WHERE "soloRequestedAt" IS NOT NULL OR "decidedSolo") THEN
    RAISE EXCEPTION 'APPROVAL_SOLO_MODE_IN_USE: requests went solo; their record is kept, not rolling back';
  END IF;
END $$;
ALTER TABLE "privileged_approvals"
  DROP CONSTRAINT IF EXISTS "privileged_approvals_self_approval_solo_only",
  DROP CONSTRAINT IF EXISTS "privileged_approvals_solo_needs_wait",
  DROP COLUMN IF EXISTS "soloRequestedAt",
  DROP COLUMN IF EXISTS "soloEligibleAt",
  DROP COLUMN IF EXISTS "decidedSolo";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261014110000_approval_solo_mode';
COMMIT;
