-- FUL-004 (fulfillment Part 4): vendor self-delivery capability + the order's
-- chosen fulfillment mode. Additive / expand-only — existing vendors stay
-- platform-rider-only (selfDeliveryEnabled false) and existing orders carry a
-- NULL mode (they predate the choice; read as PLATFORM_RIDER by default).
CREATE TYPE "FulfillmentMode" AS ENUM ('PLATFORM_RIDER', 'VENDOR_DELIVERY', 'PICKUP');
ALTER TABLE "vendors" ADD COLUMN "selfDeliveryEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "fulfillmentMode" "FulfillmentMode";
