-- ROLLBACK for 20261014230300_door_cash_return_resolved.
--
-- Roll the application back first. A RESOLVED record cannot go back under the
-- narrower check: export the resolved rows, then mark them HELD again only if
-- operations agrees the cash is still outstanding (this script refuses to run
-- while any RESOLVED row exists rather than guess).
--   SELECT "id", "orderNumber", "doorCashReturnAmount", "doorCashReturnResolvedAt", "doorCashReturnResolvedById"
--   FROM "orders" WHERE "doorCashReturnStatus" = 'RESOLVED';
SET lock_timeout = '10s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "doorCashReturnStatus" = 'RESOLVED') THEN
    RAISE EXCEPTION 'RESOLVED door-cash records exist; export and reconcile them before rolling back';
  END IF;
END $$;
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_door_cash_return_resolution";
ALTER TABLE "orders" DROP CONSTRAINT "orders_door_cash_return_complete";
ALTER TABLE "orders" ADD CONSTRAINT "orders_door_cash_return_complete"
  CHECK (("doorCashReturnAmount" IS NULL) = ("doorCashReturnStatus" IS NULL)
    AND ("doorCashReturnAmount" IS NULL) = ("doorCashReturnRecordedAt" IS NULL)
    AND ("doorCashReturnStatus" IS NULL OR "doorCashReturnStatus" IN ('RETURNED', 'HELD'))) NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_door_cash_return_complete";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "doorCashReturnResolvedById";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "doorCashReturnResolvedAt";
