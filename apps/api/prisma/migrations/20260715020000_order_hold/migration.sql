-- LIFECYCLE_V2 hold (spec Part A): pre-release cancel window on PENDING.
ALTER TABLE "orders" ADD COLUMN "holdExpiresAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "releasedToVendorAt" TIMESTAMP(3);

-- CreateIndex (release-worker tick: status = PENDING AND holdExpiresAt <= now)
CREATE INDEX "orders_status_holdExpiresAt_idx" ON "orders"("status", "holdExpiresAt");
