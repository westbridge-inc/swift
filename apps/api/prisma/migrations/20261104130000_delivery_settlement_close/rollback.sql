-- Rollback of 20261104130000_delivery_settlement_close: roll the application back first (it writes these). Refused while
-- a closed record exists: dropping the stamp would reopen a debt support closed.
SET lock_timeout = '10s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "delivery_cash_settlements" WHERE "closedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'delivery_cash_settlements holds closed records; drop nothing until they are decided';
  END IF;
END $$;
ALTER TABLE "delivery_cash_settlements" DROP COLUMN IF EXISTS "closedById";
ALTER TABLE "delivery_cash_settlements" DROP COLUMN IF EXISTS "closedAt";
