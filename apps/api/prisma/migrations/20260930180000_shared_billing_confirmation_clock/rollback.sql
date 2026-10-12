-- Only an unused expand migration may be rolled back. A clock retains timer
-- and obligation evidence even if it has no payment hold or notice. After
-- backfill or any runtime adoption, keep the schema and repair forward.
-- [Sol] These tables force row-level security, so a role that sees only some
-- rows could find them "empty". Row security is off for this transaction: a
-- role that does not bypass it is refused with an error instead. Run this as
-- a role that bypasses row-level security (a superuser or BYPASSRLS).
BEGIN;
SET LOCAL row_security = off;
LOCK TABLE billing_obligation_transitions, billing_dunning_clocks, payment_confirmation_holds, billing_fee_notices, billing_notice_handoffs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM billing_obligation_transitions)
    OR EXISTS (SELECT 1 FROM billing_dunning_clocks)
    OR EXISTS (SELECT 1 FROM payment_confirmation_holds)
    OR EXISTS (SELECT 1 FROM billing_fee_notices)
    OR EXISTS (SELECT 1 FROM billing_notice_handoffs)
    OR EXISTS (SELECT 1 FROM platform_config WHERE key='system:billing-confirmation-cutover:v1' AND value->>'state'='READY')
    OR EXISTS (SELECT 1 FROM audit_logs WHERE action IN ('BILLING_CONFIRMATION_CUTOVER_READY','BILLING_CLOCK_CANONICAL_CHANGED','BILLING_CLOCK_PAID_ADVANCE','BILLING_CLOCK_VOLUNTARY_RESUME')) THEN
    RAISE EXCEPTION 'billing clock rollback requires unused blocked expansion; preserve obligation history with a forward repair';
  END IF;
END $$;
DROP TRIGGER IF EXISTS billing_cutover_protected ON platform_config;
DELETE FROM platform_config WHERE key='system:billing-confirmation-cutover:v1';
DROP FUNCTION IF EXISTS billing_complete_confirmation_backfill(text);
DROP FUNCTION IF EXISTS billing_cutover_protected();
DROP FUNCTION IF EXISTS billing_confirmation_missing_coverage();
DROP TRIGGER IF EXISTS billing_parent_lineage ON users;
DROP TRIGGER IF EXISTS billing_parent_lineage ON subscriptions;
DROP TRIGGER IF EXISTS billing_parent_lineage ON riders;
DROP TRIGGER IF EXISTS billing_parent_lineage ON drivers;
DROP TRIGGER IF EXISTS billing_parent_lineage ON vendors;
DROP TRIGGER IF EXISTS billing_parent_lineage ON vendor_owners;
DROP FUNCTION IF EXISTS billing_preserve_parent_lineage();
DROP TRIGGER IF EXISTS billing_confirmation_source_immutable ON subscription_payments;
DROP TRIGGER IF EXISTS billing_confirmation_source_immutable ON mmg_checkout_intents;
DROP TRIGGER IF EXISTS billing_confirmation_source_immutable ON card_sessions;
DROP FUNCTION IF EXISTS billing_confirmation_source_immutable();
DROP TRIGGER billing_obligation_parent_immutable ON subscription_payments;
DROP TRIGGER billing_obligation_parent_immutable ON billing_events;
DROP TRIGGER billing_obligation_parent_immutable ON audit_logs;
DROP FUNCTION billing_obligation_parent_immutable();
DROP TABLE billing_obligation_transitions;
DROP FUNCTION billing_obligation_proof();
DROP FUNCTION billing_obligation_committed();
DROP TABLE billing_notice_handoffs;
DROP TABLE billing_fee_notices;
DROP TABLE payment_confirmation_holds;
DROP TABLE billing_dunning_clocks;
DROP FUNCTION billing_notice_lineage();
DROP FUNCTION billing_confirmation_lineage();
DROP FUNCTION billing_clock_lineage();
DROP FUNCTION IF EXISTS billing_clock_source_matches(text,text);
DROP FUNCTION billing_clock_payer(text);
ALTER TABLE subscriptions DROP COLUMN "billingConfirmationPausedAt", DROP COLUMN "billingEnforcementDueAt";
COMMIT;
