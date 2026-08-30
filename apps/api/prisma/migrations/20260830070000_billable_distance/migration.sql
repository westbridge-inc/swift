-- [ALG-18] The billable distance, frozen on the order with the engine that
-- produced it. Additive, nullable: pickups and orders placed before this
-- column carry NULL and read as "unknown" through utils/billable-distance.ts.
-- No existing value is rewritten.
SET lock_timeout = '10s';
ALTER TABLE "orders" ADD COLUMN "billableKm" DECIMAL(8,2);
ALTER TABLE "orders" ADD COLUMN "billableKmSource" TEXT;
