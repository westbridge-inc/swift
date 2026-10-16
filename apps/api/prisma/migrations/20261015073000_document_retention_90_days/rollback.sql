-- Rollback for 20261015073000_document_retention_90_days: restore the old default.
-- Rows moved to 90 by the migration are not distinguishable from rows set to 90 on purpose,
-- so only the default is restored; set a country's window back explicitly if needed.
ALTER TABLE "country_configs" ALTER COLUMN "dataRetentionDays" SET DEFAULT 365;
