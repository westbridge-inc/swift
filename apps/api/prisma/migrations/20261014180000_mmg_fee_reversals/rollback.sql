-- [MMG REVERSAL] Guarded rollback. A reversal row is money evidence (MMG was
-- asked to return a payment); the table is dropped only when it has never held
-- one. PostgreSQL cannot drop an enum value without rebuilding the type, so
-- PREPAID_REVERSAL stays in "BillingEventType" (inert while no event uses it);
-- this refuses if any event does, because the previous application's client
-- could not read it.
-- mmg_fee_reversals forces row-level security, so a role that sees only some
-- rows could find no reversal and pass the guard. Row security is switched off
-- for this transaction: a role that does not bypass it is refused with an
-- error instead. Run this as a role that bypasses row-level security (a
-- superuser or BYPASSRLS).
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "mmg_fee_reversals") THEN
    RAISE EXCEPTION 'MMG_FEE_REVERSALS_IN_USE: reversals were requested; their record is kept, not rolling back';
  END IF;
  IF EXISTS (SELECT 1 FROM "billing_events" WHERE "type"::text = 'PREPAID_REVERSAL') THEN
    RAISE EXCEPTION 'PREPAID_REVERSAL_IN_USE: a wallet was debited for a reversal; not rolling back';
  END IF;
  IF EXISTS (SELECT 1 FROM "ledger_entries" WHERE "accountCode" = 'FEE_RECEIVABLE') THEN
    RAISE EXCEPTION 'FEE_RECEIVABLE_IN_USE: a fee owed again is on the books; not rolling back';
  END IF;
END $$;
DELETE FROM "ledger_accounts" WHERE "code" = 'FEE_RECEIVABLE';
DROP TRIGGER IF EXISTS mmg_fee_reversals_forward ON "mmg_fee_reversals";
DROP FUNCTION IF EXISTS mmg_fee_reversals_forward();
DROP TABLE IF EXISTS "mmg_fee_reversals";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261014180000_mmg_fee_reversals';
COMMIT;
