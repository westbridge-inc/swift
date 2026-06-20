-- D.3 rider float-limit gate.
-- Per-rider float exposure (max vendor-cash frontable at once) + per-country,
-- per-trust-level limits. Additive, NOT NULL with defaults → no data loss.

ALTER TABLE "riders" ADD COLUMN "floatLimit" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "riders" ADD COLUMN "committedFloat" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "country_configs" ADD COLUMN "floatL1" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "country_configs" ADD COLUMN "floatL2" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "country_configs" ADD COLUMN "floatL3" DECIMAL(12,2) NOT NULL DEFAULT 0;
