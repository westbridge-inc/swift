-- [DOC-1 §4.4 · P4-4] The extraction ledger.
--
-- One extraction_run per processor call on a submission (engine, timing,
-- outcome, whether the document left the building); one extracted_field per
-- DECLARED field of the document type — value envelope-encrypted under a
-- per-run DEK wrapped by the master KEK, blind index when declared, ABSENT
-- (NULL) when the processor did not return it; one validation_result per
-- validator the pipeline evaluated. A key the registry does not declare is
-- counted on the run and never stored (DOC-INV-6). Walled like the person
-- (lineage: run → document → person; field → run; verdict → document →
-- person). Expand only; rows die with their document.

-- CreateEnum
CREATE TYPE "ExtractionSource" AS ENUM ('MRZ', 'BARCODE', 'OCR_VLM', 'HUMAN', 'DERIVED', 'PROVIDER');

-- CreateEnum
CREATE TYPE "ExtractionOutcome" AS ENUM ('OK', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ValidationStatus" AS ENUM ('PASS', 'FAIL', 'WARN', 'SKIP');

-- CreateTable
CREATE TABLE "extraction_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "submissionId" TEXT NOT NULL,
    "profileCode" TEXT NOT NULL,
    "engineName" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "modelSha256" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "outcome" "ExtractionOutcome" NOT NULL,
    "errorClass" TEXT,
    "ranExternally" BOOLEAN NOT NULL DEFAULT false,
    "processorRef" TEXT,
    "wrappedDek" BYTEA,
    "schemaViolations" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extraction_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extracted_field" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "runId" UUID NOT NULL,
    "submissionId" TEXT NOT NULL,
    "fieldCode" TEXT NOT NULL,
    "valueCt" BYTEA,
    "valueBlind" TEXT,
    "confidence" DECIMAL(4,3),
    "source" "ExtractionSource" NOT NULL,
    "bbox" JSONB,
    "isIllegible" BOOLEAN NOT NULL DEFAULT false,
    "correctedBy" TEXT,
    "correctedAt" TIMESTAMP(3),

    CONSTRAINT "extracted_field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validation_result" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "submissionId" TEXT NOT NULL,
    "validatorCode" TEXT NOT NULL,
    "status" "ValidationStatus" NOT NULL,
    "detailCode" TEXT,
    "isBlocking" BOOLEAN NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "extraction_run_submissionId_idx" ON "extraction_run"("submissionId");

-- CreateIndex
CREATE INDEX "extraction_run_tenantId_startedAt_idx" ON "extraction_run"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "extracted_field_valueBlind_idx" ON "extracted_field"("valueBlind");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_field_submissionId_fieldCode_key" ON "extracted_field"("submissionId", "fieldCode");

-- CreateIndex
CREATE UNIQUE INDEX "validation_result_submissionId_validatorCode_key" ON "validation_result"("submissionId", "validatorCode");

-- AddForeignKey
ALTER TABLE "extraction_run" ADD CONSTRAINT "extraction_run_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_run" ADD CONSTRAINT "extraction_run_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "verification_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_field" ADD CONSTRAINT "extracted_field_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_field" ADD CONSTRAINT "extracted_field_runId_fkey" FOREIGN KEY ("runId") REFERENCES "extraction_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_result" ADD CONSTRAINT "validation_result_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_result" ADD CONSTRAINT "validation_result_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "verification_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The wall, on the row itself (enabled AND forced), and the lineage held by the
-- database. Text generated from src/lib/tenant-rls.ts (rlsDdlFor, tenantLineageDdl).
ALTER TABLE "extraction_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "extraction_run" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "extraction_run";
CREATE POLICY "tenant_isolation" ON "extraction_run"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "extracted_field" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "extracted_field" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "extracted_field";
CREATE POLICY "tenant_isolation" ON "extracted_field"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "validation_result" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "validation_result" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "validation_result";
CREATE POLICY "tenant_isolation" ON "validation_result"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
CREATE OR REPLACE FUNCTION extraction_run_tenant_matches_subject() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT u."tenantId" FROM users u JOIN verification_documents d ON d."userId" = u.id WHERE d.id = NEW."submissionId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'extraction_run row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."submissionId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'extraction_run row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."submissionId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS extraction_run_tenant_matches_subject ON extraction_run;
CREATE TRIGGER extraction_run_tenant_matches_subject BEFORE INSERT OR UPDATE OF "tenantId", "submissionId" ON extraction_run FOR EACH ROW EXECUTE FUNCTION extraction_run_tenant_matches_subject();
CREATE OR REPLACE FUNCTION extracted_field_tenant_matches_run() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM extraction_run WHERE id = NEW."runId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'extracted_field row % names extraction_run row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."runId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'extracted_field row % names tenant % but its extraction_run row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."runId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS extracted_field_tenant_matches_run ON extracted_field;
CREATE TRIGGER extracted_field_tenant_matches_run BEFORE INSERT OR UPDATE OF "tenantId", "runId" ON extracted_field FOR EACH ROW EXECUTE FUNCTION extracted_field_tenant_matches_run();
CREATE OR REPLACE FUNCTION validation_result_tenant_matches_subject() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT u."tenantId" FROM users u JOIN verification_documents d ON d."userId" = u.id WHERE d.id = NEW."submissionId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'validation_result row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."submissionId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'validation_result row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."submissionId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS validation_result_tenant_matches_subject ON validation_result;
CREATE TRIGGER validation_result_tenant_matches_subject BEFORE INSERT OR UPDATE OF "tenantId", "submissionId" ON validation_result FOR EACH ROW EXECUTE FUNCTION validation_result_tenant_matches_subject();
