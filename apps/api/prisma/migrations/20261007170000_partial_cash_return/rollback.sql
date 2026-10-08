-- Roll back the application first. Export and reconcile all non-null partial
-- cash records before dropping these evidence columns on any non-test system.
-- This script moves no money and does not resolve a held-cash obligation.
SET lock_timeout = '10s';
ALTER TABLE "orders" DROP CONSTRAINT "orders_door_cash_return_not_completed_cash";
ALTER TABLE "orders" DROP CONSTRAINT "orders_door_cash_return_complete";
ALTER TABLE "orders" DROP CONSTRAINT "orders_door_cash_return_whole_positive";
ALTER TABLE "orders" DROP COLUMN "doorCashReturnRecordedAt";
ALTER TABLE "orders" DROP COLUMN "doorCashReturnStatus";
ALTER TABLE "orders" DROP COLUMN "doorCashReturnAmount";
