-- [ALG-34 / ALG-INV-14] A change to a store's or a driver's MMG pay link is
-- staged here and applied by the cool-off job at "mmgPayUrlApplyAt"; the live
-- "mmgPayUrl" keeps paying the owner until then. Additive, nullable.
SET lock_timeout = '10s';
ALTER TABLE "vendors" ADD COLUMN "mmgPayUrlPending" TEXT;
ALTER TABLE "vendors" ADD COLUMN "mmgPayUrlPendingAt" TIMESTAMP(3);
ALTER TABLE "vendors" ADD COLUMN "mmgPayUrlApplyAt" TIMESTAMP(3);
ALTER TABLE "drivers" ADD COLUMN "mmgPayUrlPending" TEXT;
ALTER TABLE "drivers" ADD COLUMN "mmgPayUrlPendingAt" TIMESTAMP(3);
ALTER TABLE "drivers" ADD COLUMN "mmgPayUrlApplyAt" TIMESTAMP(3);
CREATE INDEX "vendors_mmgPayUrlApplyAt_idx" ON "vendors"("mmgPayUrlApplyAt");
CREATE INDEX "drivers_mmgPayUrlApplyAt_idx" ON "drivers"("mmgPayUrlApplyAt");
