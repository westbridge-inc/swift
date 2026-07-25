-- FUL-003b: food/grocery delivery-fee schedule per country. Additive, nullable
-- — null keeps the existing code-default schedule (byte-for-byte the old
-- calculateDeliveryFee defaults), so no market's fees change on deploy.
ALTER TABLE "country_configs" ADD COLUMN "deliveryRates" JSONB;
