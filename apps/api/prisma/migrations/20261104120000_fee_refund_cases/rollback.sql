-- [Row 156] Guarded rollback. A case is a partner's ask for money back; the table
-- is dropped only when it has never held one. It forces row-level security, so a
-- role that sees only some rows could find none and pass the guard: row security
-- is switched off for this transaction, and a role that does not bypass it is
-- refused with an error instead. Run this as a role that bypasses row-level
-- security (a superuser or BYPASSRLS).
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "fee_refund_cases") THEN
    RAISE EXCEPTION 'FEE_REFUND_CASES_IN_USE: a partner asked for a payment back; the record is kept, not rolled back';
  END IF;
END $$;
DROP TABLE "fee_refund_cases";
DROP FUNCTION IF EXISTS fee_refund_cases_guard();
COMMIT;
