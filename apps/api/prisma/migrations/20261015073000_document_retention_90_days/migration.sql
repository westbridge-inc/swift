-- [R24 · research C4] Verification documents are kept while the relationship is active and
-- 90 days after it ends (was 365). Countries still on the old default move; a country whose
-- operator chose another number keeps it.
ALTER TABLE "country_configs" ALTER COLUMN "dataRetentionDays" SET DEFAULT 90;
UPDATE "country_configs" SET "dataRetentionDays" = 90 WHERE "dataRetentionDays" = 365;
