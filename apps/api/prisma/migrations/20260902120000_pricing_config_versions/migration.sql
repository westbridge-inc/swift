-- [M-35] Pricing config is schema-valid, finite, non-negative, versioned, and
-- in declared units. The ledger of immutable versions, and the database's own
-- floor: a pricing column, when set, is a JSON object (NOT VALID so a legacy
-- row is readable but can never be re-saved as a scalar or an array).
SET lock_timeout = '10s';

CREATE TABLE "pricing_config_versions" (
  "id" TEXT NOT NULL,
  "countryCode" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "units" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "restoredFrom" INTEGER,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pricing_config_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pricing_config_versions_countryCode_kind_version_key" ON "pricing_config_versions"("countryCode", "kind", "version");
CREATE INDEX "pricing_config_versions_countryCode_kind_payloadHash_idx" ON "pricing_config_versions"("countryCode", "kind", "payloadHash");
ALTER TABLE "pricing_config_versions" ADD CONSTRAINT "pricing_config_versions_payload_object_check" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "country_configs" ADD CONSTRAINT "country_configs_taxi_rates_object_check" CHECK ("taxiRates" IS NULL OR jsonb_typeof("taxiRates") = 'object') NOT VALID;
ALTER TABLE "country_configs" ADD CONSTRAINT "country_configs_taxi_class_rates_object_check" CHECK ("taxiClassRates" IS NULL OR jsonb_typeof("taxiClassRates") = 'object') NOT VALID;
ALTER TABLE "country_configs" ADD CONSTRAINT "country_configs_delivery_rates_object_check" CHECK ("deliveryRates" IS NULL OR jsonb_typeof("deliveryRates") = 'object') NOT VALID;
ALTER TABLE "country_configs" ADD CONSTRAINT "country_configs_courier_rates_object_check" CHECK ("courierRates" IS NULL OR jsonb_typeof("courierRates") = 'object') NOT VALID;
