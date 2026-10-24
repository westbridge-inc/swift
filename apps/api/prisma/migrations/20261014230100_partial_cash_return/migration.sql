-- Owner ruling, 7 Oct: partial cash is handed back at the door. If the rider
-- cannot return it, its amount is recorded and held for operations. These are
-- attestations, never a platform refund, deduction, or captured order payment.
-- Nullable additions preserve legacy requests. OpsAlert is the existing durable
-- page/acknowledgement rail and is committed with a held-cash record.
SET lock_timeout = '10s';
ALTER TABLE "orders" ADD COLUMN "doorCashReturnAmount" DECIMAL(12,2);
ALTER TABLE "orders" ADD COLUMN "doorCashReturnStatus" VARCHAR(16);
ALTER TABLE "orders" ADD COLUMN "doorCashReturnRecordedAt" TIMESTAMP(3);

ALTER TABLE "orders" ADD CONSTRAINT "orders_door_cash_return_whole_positive"
  CHECK ("doorCashReturnAmount" IS NULL OR
    ("doorCashReturnAmount" > 0 AND "doorCashReturnAmount" = trunc("doorCashReturnAmount"))) NOT VALID;
ALTER TABLE "orders" ADD CONSTRAINT "orders_door_cash_return_complete"
  CHECK (("doorCashReturnAmount" IS NULL) = ("doorCashReturnStatus" IS NULL)
    AND ("doorCashReturnAmount" IS NULL) = ("doorCashReturnRecordedAt" IS NULL)
    AND ("doorCashReturnStatus" IS NULL OR "doorCashReturnStatus" IN ('RETURNED', 'HELD'))) NOT VALID;
ALTER TABLE "orders" ADD CONSTRAINT "orders_door_cash_return_not_completed_cash"
  CHECK ("doorCashReturnAmount" IS NULL OR
    ("doorCashCollectedAmount" IS NULL AND "doorCashShortfallAmount" IS NULL AND "doorCashMismatchAt" IS NULL)) NOT VALID;

ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_door_cash_return_whole_positive";
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_door_cash_return_complete";
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_door_cash_return_not_completed_cash";
