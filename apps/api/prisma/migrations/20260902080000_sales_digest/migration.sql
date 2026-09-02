-- [M-27] The weekly settlement is a SALES DIGEST: canonical calendar periods,
-- one DIGEST row per vendor and period, immutable ADJUSTMENT rows for
-- corrections, discounts allocated, and ACKNOWLEDGED instead of a fictional
-- PAID. Additive: new columns with defaults, a new enum value, a unique key.
SET lock_timeout = '10s';

ALTER TYPE "SettlementStatus" ADD VALUE IF NOT EXISTS 'ACKNOWLEDGED';

ALTER TABLE "settlements"
  ADD COLUMN "kind"          TEXT NOT NULL DEFAULT 'DIGEST',
  ADD COLUMN "sequence"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "supersedesId"  TEXT,
  ADD COLUMN "reason"        TEXT,
  ADD COLUMN "totalDiscount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "netSales"      DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Legacy rows carry no discount figure: their net is their base until an
-- adjustment recomputes them from the ledger.
UPDATE "settlements" SET "netSales" = "totalBase" WHERE "netSales" = 0;

-- Legacy duplicates of one (vendor, period) — two runs that happened to share
-- a wall-clock window — become later, immutable rows of that period rather
-- than a unique-key failure: the earliest keeps sequence 0.
WITH d AS (
  SELECT "id", row_number() OVER (PARTITION BY "vendorId", "periodStart" ORDER BY "createdAt", "id") - 1 AS seq
  FROM "settlements"
)
UPDATE "settlements" s
   SET "sequence" = d.seq,
       "kind" = CASE WHEN d.seq > 0 THEN 'ADJUSTMENT' ELSE 'DIGEST' END,
       "reason" = CASE WHEN d.seq > 0 THEN 'legacy duplicate of this period (pre-M-27 sliding window)' ELSE NULL END
  FROM d
 WHERE s."id" = d."id" AND d.seq > 0;

CREATE UNIQUE INDEX "settlements_vendorId_periodStart_sequence_key" ON "settlements"("vendorId", "periodStart", "sequence");
CREATE INDEX "settlements_vendorId_periodStart_idx" ON "settlements"("vendorId", "periodStart");
