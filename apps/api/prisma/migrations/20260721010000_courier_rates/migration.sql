-- UG-CRAFT-03: per-country courier pricing, mirroring taxiRates — additive
-- nullable JSON; null keeps today's code defaults byte-identical.
ALTER TABLE "country_configs" ADD COLUMN "courierRates" JSONB;
