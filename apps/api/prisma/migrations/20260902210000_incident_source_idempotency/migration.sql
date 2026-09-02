-- [S-08] Incident intake has no source idempotency and retries fabricate severity.
-- One source creates one case: the fingerprint is the database's floor.
ALTER TABLE "IncidentCase" ADD COLUMN "sourceType" TEXT;
ALTER TABLE "IncidentCase" ADD COLUMN "sourceId" TEXT;
ALTER TABLE "IncidentCase" ADD COLUMN "sourceFingerprint" TEXT;
ALTER TABLE "IncidentCase" ADD COLUMN "replayCount" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "IncidentCase_sourceFingerprint_key" ON "IncidentCase"("sourceFingerprint");
CREATE INDEX "IncidentCase_subjectUserId_orderId_category_createdAt_idx" ON "IncidentCase"("subjectUserId", "orderId", "category", "createdAt");
