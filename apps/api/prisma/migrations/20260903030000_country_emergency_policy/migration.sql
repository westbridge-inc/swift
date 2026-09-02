-- [MOB-018] The market emergency policy lives on the market: per service, a
-- dialable number and whether ops verified it. Null = no policy yet.
ALTER TABLE "country_configs" ADD COLUMN "emergency" JSONB;
