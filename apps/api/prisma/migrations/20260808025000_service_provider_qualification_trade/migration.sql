-- Bind every new service qualification to the canonical trade selected at
-- submission time. Existing rows deliberately remain NULL: the former path
-- treated a regex-shaped reference as registry verification and recorded no
-- trade provenance, so grandfathering them into a public badge would preserve
-- the exact trust bug this migration closes.
ALTER TABLE "service_qualifications"
  ADD COLUMN "trade" TEXT;

CREATE INDEX "service_qualifications_providerId_trade_status_idx"
  ON "service_qualifications"("providerId", "trade", "status");

-- Canonicalize known legacy profile aliases. Unknown free text remains intact
-- and therefore fails the runtime catalog gate until its owner explicitly
-- chooses a supported trade.
UPDATE "service_providers"
SET "trade" = CASE
  WHEN lower(regexp_replace("trade", '[^a-zA-Z0-9]+', ' ', 'g')) IN ('electrician', 'electrical', 'electrical contractor', 'electrical installation contractor') THEN 'electrician'
  WHEN lower(regexp_replace("trade", '[^a-zA-Z0-9]+', ' ', 'g')) IN ('plumber', 'plumbing', 'major plumbing') THEN 'plumber'
  WHEN lower(regexp_replace("trade", '[^a-zA-Z0-9]+', ' ', 'g')) IN ('gas fitter', 'gas fitting', 'gas technician') THEN 'gas_fitter'
  WHEN lower(regexp_replace("trade", '[^a-zA-Z0-9]+', ' ', 'g')) IN ('carpenter', 'carpentry', 'joiner', 'carpenter joiner') THEN 'carpenter'
  WHEN lower(regexp_replace("trade", '[^a-zA-Z0-9]+', ' ', 'g')) IN ('cleaner', 'cleaning', 'house cleaner') THEN 'cleaner'
  WHEN lower(regexp_replace("trade", '[^a-zA-Z0-9]+', ' ', 'g')) IN ('ac repair', 'a c repair', 'ac refrigeration', 'ac and refrigeration technician', 'air conditioning repair', 'refrigeration technician', 'hvac') THEN 'ac_refrigeration'
  WHEN lower(regexp_replace("trade", '[^a-zA-Z0-9]+', ' ', 'g')) IN ('mechanic', 'auto mechanic', 'vehicle mechanic') THEN 'mechanic'
  WHEN lower(regexp_replace("trade", '[^a-zA-Z0-9]+', ' ', 'g')) IN ('painter', 'painting', 'house painter') THEN 'painter'
  WHEN lower(regexp_replace("trade", '[^a-zA-Z0-9]+', ' ', 'g')) IN ('mason', 'masonry', 'bricklayer') THEN 'mason'
  WHEN lower(regexp_replace("trade", '[^a-zA-Z0-9]+', ' ', 'g')) IN ('welder', 'welding', 'fabricator', 'welder fabricator') THEN 'welder'
  WHEN lower(regexp_replace("trade", '[^a-zA-Z0-9]+', ' ', 'g')) IN ('gardener', 'gardening', 'landscaper', 'landscaping') THEN 'gardener'
  ELSE "trade"
END;
