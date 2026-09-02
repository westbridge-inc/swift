-- [R045-ADS-04 · 05 · 06] The ad checkout aggregate. One open payment
-- instruction per campaign and one provider reference per payment are the
-- database's floor; a late external capture is its own refund reason.
-- Duplicates that exist are frozen first (the operations clause): extra
-- UNPAID invoices on one campaign are VOIDed (newest kept), and a reused
-- provider reference is suffixed on the later rows so nothing is lost and
-- nothing collides.
SET lock_timeout = '10s';

ALTER TYPE "AdRefundReason" ADD VALUE IF NOT EXISTS 'LATE_CAPTURE';

UPDATE "ad_invoices" i SET "status" = 'VOID'
WHERE i."status" = 'UNPAID'
  AND EXISTS (SELECT 1 FROM "ad_invoices" j WHERE j."campaignId" = i."campaignId" AND j."status" = 'UNPAID' AND j."createdAt" > i."createdAt");

UPDATE "ad_invoices" i SET "providerRef" = i."providerRef" || ':dup:' || i."id"
WHERE i."providerRef" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "ad_invoices" j WHERE j."providerRef" = i."providerRef" AND j."createdAt" < i."createdAt");

CREATE UNIQUE INDEX "ad_invoices_one_unpaid_per_campaign_key" ON "ad_invoices"("campaignId") WHERE "status" = 'UNPAID';
CREATE UNIQUE INDEX "ad_invoices_providerRef_unique_key" ON "ad_invoices"("providerRef") WHERE "providerRef" IS NOT NULL;
