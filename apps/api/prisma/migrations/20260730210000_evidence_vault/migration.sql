-- CreateEnum
CREATE TYPE "EvidenceItemKind" AS ENUM ('SOS_ALERT', 'INCIDENT_CASE', 'ORDER_SNAPSHOT', 'STATUS_TIMELINE', 'GUARDIAN_SESSION', 'LIVENESS_CHECKS', 'CHAT_TRANSCRIPT', 'FANOUT_RECEIPTS', 'LOCATION_FIX', 'NOTE');

-- CreateTable
CREATE TABLE "EvidenceBundle" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "bundleNumber" TEXT NOT NULL,
    "sosAlertId" TEXT,
    "caseId" TEXT,
    "subjectUserId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sealedAt" TIMESTAMP(3),
    "sealedBy" TEXT,
    "sealHash" TEXT,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceItem" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "kind" "EvidenceItemKind" NOT NULL,
    "label" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sealedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyAccessLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "bundleId" TEXT NOT NULL,
    "accessorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SafetyAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceBundle_bundleNumber_key" ON "EvidenceBundle"("bundleNumber");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceBundle_sosAlertId_key" ON "EvidenceBundle"("sosAlertId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceBundle_caseId_key" ON "EvidenceBundle"("caseId");

-- CreateIndex
CREATE INDEX "EvidenceBundle_tenantId_sealedAt_idx" ON "EvidenceBundle"("tenantId", "sealedAt");

-- CreateIndex
CREATE INDEX "EvidenceBundle_subjectUserId_idx" ON "EvidenceBundle"("subjectUserId");

-- CreateIndex
CREATE INDEX "EvidenceItem_bundleId_idx" ON "EvidenceItem"("bundleId");

-- CreateIndex
CREATE INDEX "SafetyAccessLog_bundleId_at_idx" ON "SafetyAccessLog"("bundleId", "at");

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "EvidenceBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Tamper-evidence at the DATABASE layer (safety spec §9.2) ───────────────
-- The service layer refuses to touch sealed evidence; these triggers make the
-- DB itself refuse, so no future code path, admin console, or raw query can
-- quietly rewrite history. Sealed = immutable, forever.

CREATE OR REPLACE FUNCTION evidence_item_block_sealed() RETURNS trigger AS $$
BEGIN
  IF OLD."sealedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'evidence item % is sealed — sealed evidence is immutable', OLD."id";
  END IF;
  IF (TG_OP = 'DELETE') THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_item_no_mutation
BEFORE UPDATE OR DELETE ON "EvidenceItem"
FOR EACH ROW EXECUTE FUNCTION evidence_item_block_sealed();

CREATE OR REPLACE FUNCTION evidence_item_block_insert_into_sealed() RETURNS trigger AS $$
BEGIN
  IF (SELECT "sealedAt" FROM "EvidenceBundle" WHERE "id" = NEW."bundleId") IS NOT NULL THEN
    RAISE EXCEPTION 'evidence bundle % is sealed — no new items may be added', NEW."bundleId";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_item_no_insert_after_seal
BEFORE INSERT ON "EvidenceItem"
FOR EACH ROW EXECUTE FUNCTION evidence_item_block_insert_into_sealed();

CREATE OR REPLACE FUNCTION evidence_bundle_block_delete_sealed() RETURNS trigger AS $$
BEGIN
  IF OLD."sealedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'evidence bundle % is sealed — sealed bundles cannot be deleted', OLD."id";
  END IF;
  IF OLD."legalHold" THEN
    RAISE EXCEPTION 'evidence bundle % is under legal hold', OLD."id";
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_bundle_no_delete_sealed
BEFORE DELETE ON "EvidenceBundle"
FOR EACH ROW EXECUTE FUNCTION evidence_bundle_block_delete_sealed();
