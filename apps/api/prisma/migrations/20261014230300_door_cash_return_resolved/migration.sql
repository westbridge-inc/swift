-- Partial cash a rider could not hand back (HELD) gets a way out: operations
-- records that it is resolved (review of #1542, 14 Oct). Before this, nothing
-- in the product could move HELD, so a rider holding a customer's partial cash
-- could never close their account. Resolving is a record only: Swift moves,
-- refunds and deducts nothing. The stated reason and the admin who recorded it
-- are in the admin audit row; the rider's original HELD report stays in the
-- status trail and the operations alert.
--
--   doorCashReturnStatus      gains 'RESOLVED' (only ever from HELD, in code)
--   doorCashReturnResolvedAt  when operations recorded it
--   doorCashReturnResolvedById the admin who recorded it
--
-- ADDITIVE AND INERT: two nullable columns with no default, and a constraint
-- swap that only widens the allowed status list. Added NOT VALID, then
-- validated, so the scan takes only a SHARE UPDATE EXCLUSIVE lock on "orders".
--
-- ROLLBACK: rollback.sql in this directory (roll the application back first).
SET lock_timeout = '10s';
ALTER TABLE "orders" ADD COLUMN "doorCashReturnResolvedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "doorCashReturnResolvedById" TEXT;

ALTER TABLE "orders" DROP CONSTRAINT "orders_door_cash_return_complete";
ALTER TABLE "orders" ADD CONSTRAINT "orders_door_cash_return_complete"
  CHECK (("doorCashReturnAmount" IS NULL) = ("doorCashReturnStatus" IS NULL)
    AND ("doorCashReturnAmount" IS NULL) = ("doorCashReturnRecordedAt" IS NULL)
    AND ("doorCashReturnStatus" IS NULL OR "doorCashReturnStatus" IN ('RETURNED', 'HELD', 'RESOLVED'))) NOT VALID;
-- A resolution carries when and who, and exists only on a RESOLVED record.
ALTER TABLE "orders" ADD CONSTRAINT "orders_door_cash_return_resolution"
  CHECK ((COALESCE("doorCashReturnStatus" = 'RESOLVED', false)) = ("doorCashReturnResolvedAt" IS NOT NULL)
    AND ("doorCashReturnResolvedAt" IS NULL) = ("doorCashReturnResolvedById" IS NULL)) NOT VALID;

ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_door_cash_return_complete";
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_door_cash_return_resolution";
