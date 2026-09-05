-- [DOC-1 §9.4 · P9-4] Legal holds on document submissions.
--
-- One hold names one person, a reason, an accountable owner and a review date.
-- While a document carries the hold it cannot be purged — by the reaper or by
-- account erasure (DOC-INV-14). Overdue holds alarm (DOC-INV-32). Expand only;
-- a hold with documents cannot be deleted (RESTRICT) — it is released.

-- CreateTable
CREATE TABLE "doc_legal_hold" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "subjectUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "reviewBy" TIMESTAMP(3) NOT NULL,
    "placedBy" TEXT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "releaseReason" TEXT,
    "incidentCaseId" TEXT,

    CONSTRAINT "doc_legal_hold_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "verification_documents" ADD COLUMN "legalHoldId" UUID;

-- CreateIndex
CREATE INDEX "doc_legal_hold_subjectUserId_releasedAt_idx" ON "doc_legal_hold"("subjectUserId", "releasedAt");

-- CreateIndex
CREATE INDEX "doc_legal_hold_tenantId_releasedAt_reviewBy_idx" ON "doc_legal_hold"("tenantId", "releasedAt", "reviewBy");

-- CreateIndex
CREATE INDEX "verification_documents_legalHoldId_idx" ON "verification_documents"("legalHoldId");

-- AddForeignKey
ALTER TABLE "doc_legal_hold" ADD CONSTRAINT "doc_legal_hold_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_legal_hold" ADD CONSTRAINT "doc_legal_hold_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_legal_hold" ADD CONSTRAINT "doc_legal_hold_incidentCaseId_fkey" FOREIGN KEY ("incidentCaseId") REFERENCES "IncidentCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_legalHoldId_fkey" FOREIGN KEY ("legalHoldId") REFERENCES "doc_legal_hold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Facts the database holds: a review date after placement; a release owes an actor.
ALTER TABLE "doc_legal_hold" ADD CONSTRAINT "doc_legal_hold_review_after_placed" CHECK ("reviewBy" > "placedAt");
ALTER TABLE "doc_legal_hold" ADD CONSTRAINT "doc_legal_hold_release_owes_actor" CHECK ("releasedAt" IS NULL OR "releasedBy" IS NOT NULL);

-- The wall, on the row itself (enabled AND forced), and the lineage held by the
-- database. Text generated from src/lib/tenant-rls.ts (rlsDdlFor, tenantLineageDdl).
ALTER TABLE "doc_legal_hold" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "doc_legal_hold" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "doc_legal_hold";
CREATE POLICY "tenant_isolation" ON "doc_legal_hold"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
CREATE OR REPLACE FUNCTION doc_legal_hold_tenant_matches_subject() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM users WHERE id = NEW."subjectUserId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'doc_legal_hold row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."subjectUserId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'doc_legal_hold row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."subjectUserId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS doc_legal_hold_tenant_matches_subject ON doc_legal_hold;
CREATE TRIGGER doc_legal_hold_tenant_matches_subject BEFORE INSERT OR UPDATE OF "tenantId", "subjectUserId" ON doc_legal_hold FOR EACH ROW EXECUTE FUNCTION doc_legal_hold_tenant_matches_subject();
