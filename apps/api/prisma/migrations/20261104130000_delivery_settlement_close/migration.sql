-- Swift support closes a delivery-pay record neither side can (a store that never confirms, or has left Swift).
-- delivery-cash-settlement.service.ts closeSettlementBySwift writes these; the status and every other fact on the row stay
-- as they were: a closed record is not a settled one. EXPAND only: two nullable columns on delivery_cash_settlements.
--
-- FORWARD
--  1. delivery_cash_settlements."closedAt": when support closed it. Set: it blocks nobody and nobody can confirm it.
--  2. delivery_cash_settlements."closedById": the admin who closed it (the reason is in the audit row).
--
-- ROLLBACK: rollback.sql beside this file (refused while a closed record exists; roll the application back first).
SET lock_timeout = '10s';

ALTER TABLE "delivery_cash_settlements" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3);
ALTER TABLE "delivery_cash_settlements" ADD COLUMN IF NOT EXISTS "closedById" TEXT;
