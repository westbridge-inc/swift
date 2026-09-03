-- [W-26] A cash settlement closes a real debt between a store and a rider.
-- The row recorded only WHEN each side confirmed, never WHO, and never what
-- amount that person said changed hands. Both are required for the handover to
-- be accountable after the fact.
ALTER TABLE "delivery_cash_settlements" ADD COLUMN "riderConfirmedById" TEXT;
ALTER TABLE "delivery_cash_settlements" ADD COLUMN "storeConfirmedById" TEXT;
ALTER TABLE "delivery_cash_settlements" ADD COLUMN "riderAttestedAmount" DECIMAL(10,2);
ALTER TABLE "delivery_cash_settlements" ADD COLUMN "storeAttestedAmount" DECIMAL(10,2);
