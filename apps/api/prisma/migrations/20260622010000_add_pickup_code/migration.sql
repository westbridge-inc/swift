-- Takeaway / pickup: a 4-digit code the customer shows to collect a PICKUP
-- order, which the vendor verifies to close it (no rider involved).
ALTER TABLE "orders" ADD COLUMN "pickupCode" TEXT;
