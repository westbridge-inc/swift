-- Operator promotions (master plan §4.2): vendors issue their own promo codes.
-- vendorId null keeps existing platform-wide (admin) codes untouched.
ALTER TABLE "promo_codes" ADD COLUMN     "vendorId" TEXT;

CREATE INDEX "promo_codes_vendorId_idx" ON "promo_codes"("vendorId");

ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
