-- Double-blind rating release (marketplace-mechanics §1)
ALTER TABLE "ratings" ADD COLUMN "visibleAt" TIMESTAMP(3);
CREATE INDEX "ratings_visibleAt_idx" ON "ratings"("visibleAt");
-- Every existing rating predates the blind window: release them all.
UPDATE "ratings" SET "visibleAt" = "createdAt";
