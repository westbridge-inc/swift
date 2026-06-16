-- Phase 6 — trust completeness: rating anti-manipulation flags + CountryConfig region fields

-- AlterTable
ALTER TABLE "country_configs" ADD COLUMN     "insuranceClassName" TEXT,
ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "regulatoryNotes" TEXT,
ADD COLUMN     "taxiCredentialName" TEXT,
ADD COLUMN     "verificationSources" JSONB;

-- AlterTable
ALTER TABLE "ratings" ADD COLUMN     "flagReason" TEXT,
ADD COLUMN     "flagged" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ratings_raterId_idx" ON "ratings"("raterId");

-- CreateIndex
CREATE INDEX "ratings_vendorId_idx" ON "ratings"("vendorId");

-- CreateIndex
CREATE INDEX "ratings_rateeId_idx" ON "ratings"("rateeId");

-- CreateIndex
CREATE INDEX "ratings_flagged_idx" ON "ratings"("flagged");
