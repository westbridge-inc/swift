-- Phase 2 — Document storage & DPA compliance (spec §3.5)
-- Additive only: consent + retention metadata and storage region.

-- AlterTable
ALTER TABLE "country_configs" ADD COLUMN     "dataRetentionDays" INTEGER NOT NULL DEFAULT 365,
ADD COLUMN     "storageRegion" TEXT;

-- AlterTable
ALTER TABLE "verification_documents" ADD COLUMN     "consentAt" TIMESTAMP(3),
ADD COLUMN     "privacyNoticeVersion" TEXT,
ADD COLUMN     "purgedAt" TIMESTAMP(3),
ADD COLUMN     "retentionExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "verification_documents_retentionExpiresAt_idx" ON "verification_documents"("retentionExpiresAt");
