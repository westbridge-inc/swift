-- [ALG-16] The actual, map-matched path of a completed delivery, frozen once
-- beside the planned distance the customer was priced on. Additive, nullable.
SET lock_timeout = '10s';
ALTER TABLE "orders" ADD COLUMN "routeMatchedKm" DECIMAL(8,2);
ALTER TABLE "orders" ADD COLUMN "routePolyline" TEXT;
ALTER TABLE "orders" ADD COLUMN "routeMatchSource" TEXT;
ALTER TABLE "orders" ADD COLUMN "routeMatchedAt" TIMESTAMP(3);
