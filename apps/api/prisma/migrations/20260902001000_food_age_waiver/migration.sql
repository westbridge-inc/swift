-- [TA-S0-001 hold v3] An operator's durable "deliver anyway" decision on a
-- held paid order: the cutoff no longer applies to it. Additive, nullable.
ALTER TABLE "orders" ADD COLUMN "foodAgeWaivedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "foodAgeWaivedBy" TEXT;
