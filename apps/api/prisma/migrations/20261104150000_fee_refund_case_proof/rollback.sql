-- [Row 156] Rollback: the guard as 20261104120000_fee_refund_cases left it. A case
-- already closed on a RETURNED_NOT_BOOKED return stays closed: REFUNDED is final.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION fee_refund_cases_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'OPEN' THEN
      RAISE EXCEPTION 'fee_refund_cases: a case is born OPEN [Row 156]' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
     OR NEW."checkoutId" IS DISTINCT FROM OLD."checkoutId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."openedByUserId" IS DISTINCT FROM OLD."openedByUserId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."dueBy" IS DISTINCT FROM OLD."dueBy"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'fee_refund_cases row %: what was asked is written once [Row 156]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" = 'REFUNDED' AND (NEW."state" IS DISTINCT FROM OLD."state"
       OR NEW."reversalId" IS DISTINCT FROM OLD."reversalId" OR NEW."refundedAt" IS DISTINCT FROM OLD."refundedAt") THEN
    RAISE EXCEPTION 'fee_refund_cases row %: a refunded case is final [Row 156]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" = 'OPEN' AND NEW."state" = 'REFUNDED' AND NOT EXISTS (
       SELECT 1 FROM "mmg_fee_reversals" r
       WHERE r."id" = NEW."reversalId" AND r."checkoutId" = NEW."checkoutId" AND r."state" = 'REVERSED') THEN
    RAISE EXCEPTION 'fee_refund_cases row %: only a REVERSED reversal of this payment closes a case [Row 156]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS fee_refund_cases_guard ON "fee_refund_cases";
CREATE TRIGGER fee_refund_cases_guard BEFORE INSERT OR UPDATE ON "fee_refund_cases"
  FOR EACH ROW EXECUTE FUNCTION fee_refund_cases_guard();
COMMIT;
