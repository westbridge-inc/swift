-- [PT-4] Guarded rollback: the columns hold money evidence (a provider
-- transaction reference, a void or refund claim, a finance decision). They
-- are removed only when no row has ever used them; otherwise this refuses.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "card_sessions" WHERE "providerTransactionRef" IS NOT NULL OR "providerVoidState" IS NOT NULL
             OR "providerRefundState" IS NOT NULL OR "bookClaimedAt" IS NOT NULL OR "resolution" IS NOT NULL) THEN
    RAISE EXCEPTION 'CARD_PROVIDER_ACTIONS_IN_USE: card sessions carry provider references, void/refund/booking claims or finance decisions; not rolling back';
  END IF;
END $$;
DROP TRIGGER IF EXISTS card_sessions_provider_actions ON card_sessions;
DROP FUNCTION IF EXISTS card_sessions_provider_actions();
ALTER TABLE "card_sessions"
  DROP CONSTRAINT IF EXISTS "card_sessions_provider_ref_check",
  DROP CONSTRAINT IF EXISTS "card_sessions_void_state_check",
  DROP CONSTRAINT IF EXISTS "card_sessions_refund_state_check",
  DROP CONSTRAINT IF EXISTS "card_sessions_resolution_check",
  DROP CONSTRAINT IF EXISTS "card_sessions_void_needs_ref_check",
  DROP CONSTRAINT IF EXISTS "card_sessions_refund_needs_ref_check",
  DROP COLUMN IF EXISTS "providerTransactionRef",
  DROP COLUMN IF EXISTS "providerVoidState",
  DROP COLUMN IF EXISTS "providerVoidAt",
  DROP COLUMN IF EXISTS "providerRefundState",
  DROP COLUMN IF EXISTS "providerRefundAt",
  DROP COLUMN IF EXISTS "bookClaimedAt",
  DROP COLUMN IF EXISTS "resolution",
  DROP COLUMN IF EXISTS "resolvedBy",
  DROP COLUMN IF EXISTS "resolvedAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261007151500_card_session_provider_actions';
COMMIT;
