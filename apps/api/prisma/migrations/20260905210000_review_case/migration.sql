-- [DOC-1 §4.4 · P4-5] Review cases and decisions.
--
-- A document that lands in human review opens ONE case (queue STANDARD, or
-- SECOND_REVIEW when the cross-subject collision rule fired) with a 24h SLA
-- (§13). Every approve or reject writes a decision and closes the case in the
-- same transaction as the status change; the SLA watchdog reads the case
-- table. Walled like the person (lineage: case → document → person; decision
-- → case). Expand only, plus a backfill so no pending document is caseless.

-- CreateEnum
CREATE TYPE "ReviewQueue" AS ENUM ('STANDARD', 'SECOND_REVIEW', 'ESCALATED', 'QA_BLIND');

-- CreateEnum
CREATE TYPE "ReviewOutcome" AS ENUM ('APPROVE', 'REJECT', 'REQUEST_INFO', 'ESCALATE');

-- CreateTable
CREATE TABLE "review_case" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "submissionId" TEXT NOT NULL,
    "queue" "ReviewQueue" NOT NULL DEFAULT 'STANDARD',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "assignedTo" TEXT,
    "assignedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_decision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "caseId" UUID NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "outcome" "ReviewOutcome" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "internalNote" TEXT,
    "actorFacingCategory" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timeOnCaseMs" INTEGER,

    CONSTRAINT "review_decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_case_submissionId_idx" ON "review_case"("submissionId");

-- CreateIndex
CREATE INDEX "review_case_tenantId_closedAt_slaDueAt_idx" ON "review_case"("tenantId", "closedAt", "slaDueAt");

-- CreateIndex
CREATE INDEX "review_decision_caseId_idx" ON "review_decision"("caseId");

-- AddForeignKey
ALTER TABLE "review_case" ADD CONSTRAINT "review_case_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "review_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Truth first: every document already waiting on a human gets its case, with
-- the SLA it has had since it was queued.
INSERT INTO "review_case" ("submissionId", "tenantId", "queue", "slaDueAt", "createdAt")
SELECT d.id, u."tenantId", 'STANDARD'::"ReviewQueue", d."createdAt" + interval '24 hours', d."createdAt"
  FROM "verification_documents" d JOIN "users" u ON u.id = d."userId"
 WHERE d.status = 'PENDING'
   AND NOT EXISTS (SELECT 1 FROM "review_case" c WHERE c."submissionId" = d.id AND c."closedAt" IS NULL);

-- The wall, on the row itself (enabled AND forced).
ALTER TABLE "review_case" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_case" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "review_case";
CREATE POLICY "tenant_isolation" ON "review_case"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "review_decision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_decision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "review_decision";
CREATE POLICY "tenant_isolation" ON "review_decision"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- Lineage held by the database. Text mirrored by tenantLineageDdl() in src/lib/tenant-rls.ts.
CREATE OR REPLACE FUNCTION review_case_tenant_matches_subject() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT u."tenantId" FROM users u JOIN verification_documents d ON d."userId" = u.id WHERE d.id = NEW."submissionId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'review_case row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."submissionId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'review_case row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."submissionId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS review_case_tenant_matches_subject ON review_case;
CREATE TRIGGER review_case_tenant_matches_subject BEFORE INSERT OR UPDATE OF "tenantId", "submissionId" ON review_case FOR EACH ROW EXECUTE FUNCTION review_case_tenant_matches_subject();
CREATE OR REPLACE FUNCTION review_decision_tenant_matches_case() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM review_case WHERE id = NEW."caseId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'review_decision row % names review_case row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."caseId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'review_decision row % names tenant % but its review_case row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."caseId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS review_decision_tenant_matches_case ON review_decision;
CREATE TRIGGER review_decision_tenant_matches_case BEFORE INSERT OR UPDATE OF "tenantId", "caseId" ON review_decision FOR EACH ROW EXECUTE FUNCTION review_decision_tenant_matches_case();
