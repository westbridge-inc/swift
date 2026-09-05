-- [DOC-1 §24.2 · P24] A fraud case: suspicion confirmed by a SECOND reviewer, created
-- in one transaction with the rejection, the legal hold on the person's documents and
-- the founder-pending enforcement hold. Referral is a founder decision only (FD-DOC-16).

-- CreateTable
CREATE TABLE "fraud_case" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "subjectUserId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "caseId" UUID NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "legalHoldId" UUID,
    "enforcementId" TEXT,
    "linkedAccountIds" JSONB NOT NULL,
    "referral" TEXT NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fraud_case_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fraud_case_subjectUserId_idx" ON "fraud_case"("subjectUserId");

-- CreateIndex
CREATE INDEX "fraud_case_tenantId_createdAt_idx" ON "fraud_case"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "fraud_case" ADD CONSTRAINT "fraud_case_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_case" ADD CONSTRAINT "fraud_case_legalHoldId_fkey" FOREIGN KEY ("legalHoldId") REFERENCES "doc_legal_hold"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The wall, on the row itself (enabled AND forced), and the lineage held by the
-- database. Text generated from src/lib/tenant-rls.ts (rlsDdlFor, tenantLineageDdl).
ALTER TABLE "fraud_case" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fraud_case" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "fraud_case";
CREATE POLICY "tenant_isolation" ON "fraud_case"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
CREATE OR REPLACE FUNCTION fraud_case_tenant_matches_subject() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM users WHERE id = NEW."subjectUserId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'fraud_case row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."subjectUserId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'fraud_case row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."subjectUserId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS fraud_case_tenant_matches_subject ON fraud_case;
CREATE TRIGGER fraud_case_tenant_matches_subject BEFORE INSERT OR UPDATE OF "tenantId", "subjectUserId" ON fraud_case FOR EACH ROW EXECUTE FUNCTION fraud_case_tenant_matches_subject();
