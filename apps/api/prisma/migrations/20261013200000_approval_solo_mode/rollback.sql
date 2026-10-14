-- [OWNER #13] Guarded rollback: the solo columns are the record of how an
-- approval was given. They are removed only when no request ever went solo;
-- otherwise this refuses, and the record stays.
BEGIN;
SET LOCAL lock_timeout = '10s';
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
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261013200000_approval_solo_mode';
COMMIT;
