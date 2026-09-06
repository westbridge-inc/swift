-- [DOC-1 §4.4 · P4-2] document_record: the durable, post-purge truth, kept by the database from the state
-- machine; VerificationDocument.imagePurgedAt = the image-policy purge seam. Schema half by `prisma migrate diff`;
-- the wall by src/lib/tenant-rls.ts; the trigger + backfill by src/modules/verification/document-record.ts (mirrored verbatim).

-- CreateEnum
CREATE TYPE "DocumentRecordStatus" AS ENUM ('VALID', 'EXPIRED', 'REVOKED', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "verification_documents" ADD COLUMN     "imagePurgedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "document_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "accountId" TEXT NOT NULL,
    "subjectId" UUID,
    "docType" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "status" "DocumentRecordStatus" NOT NULL DEFAULT 'VALID',
    "issuedOn" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3),
    "recheckBy" TIMESTAMP(3),
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "contentSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_record_submissionId_key" ON "document_record"("submissionId");

-- CreateIndex
CREATE INDEX "document_record_tenantId_accountId_docType_status_idx" ON "document_record"("tenantId", "accountId", "docType", "status");

-- CreateIndex
CREATE INDEX "document_record_subjectId_docType_status_idx" ON "document_record"("subjectId", "docType", "status");

-- CreateIndex
CREATE INDEX "document_record_expiresOn_idx" ON "document_record"("expiresOn");

-- AddForeignKey
ALTER TABLE "document_record" ADD CONSTRAINT "document_record_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_record" ADD CONSTRAINT "document_record_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_record" ADD CONSTRAINT "document_record_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "verification_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── tenant wall ──
ALTER TABLE "document_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_record" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "document_record";
CREATE POLICY "tenant_isolation" ON "document_record"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
CREATE OR REPLACE FUNCTION document_record_tenant_matches_account() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM users WHERE id = NEW."accountId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'document_record row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."accountId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'document_record row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."accountId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS document_record_tenant_matches_account ON document_record;
CREATE TRIGGER document_record_tenant_matches_account BEFORE INSERT OR UPDATE OF "tenantId", "accountId" ON document_record FOR EACH ROW EXECUTE FUNCTION document_record_tenant_matches_account();

-- ── the record is kept by the database ──
CREATE OR REPLACE FUNCTION verification_documents_keep_record() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant TEXT;
BEGIN
  IF NEW.state = 'COMMITTED' THEN
    SELECT "tenantId" INTO v_tenant FROM users WHERE id = NEW."userId";
    INSERT INTO document_record (id, "tenantId", "accountId", "subjectId", "docType", "submissionId", status, "expiresOn", "approvedBy", "approvedAt", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), COALESCE(v_tenant, 'swift-default'), NEW."userId", NEW."subjectId", NEW."docType", NEW.id, 'VALID',
            NEW."expiresAt", COALESCE(NEW."reviewedBy", 'system'), COALESCE(NEW."reviewedAt", now()), now(), now())
    ON CONFLICT ("submissionId") DO UPDATE
      SET status = 'VALID', "expiresOn" = EXCLUDED."expiresOn", "subjectId" = EXCLUDED."subjectId", "updatedAt" = now();
    -- A newer commit of the same type, for the same account and subject, supersedes the older
    -- committed submissions (§22); their records follow through this same trigger (one mechanism).
    UPDATE verification_documents SET state = 'SUPERSEDED'
      WHERE "userId" = NEW."userId" AND "docType" = NEW."docType" AND id <> NEW.id
        AND "subjectId" IS NOT DISTINCT FROM NEW."subjectId" AND state = 'COMMITTED';
  ELSIF NEW.state IN ('EXPIRED', 'REVOKED', 'SUPERSEDED') THEN
    UPDATE document_record SET status = NEW.state::text::"DocumentRecordStatus", "updatedAt" = now()
      WHERE "submissionId" = NEW.id AND status <> NEW.state::text::"DocumentRecordStatus";
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS verification_documents_keep_record ON verification_documents;

CREATE TRIGGER verification_documents_keep_record
AFTER INSERT OR UPDATE OF state, status, "purgedAt", "expiresAt", "subjectId" ON verification_documents
FOR EACH ROW EXECUTE FUNCTION verification_documents_keep_record();

-- ── §10.3 grandfather backfill ──
INSERT INTO document_record (id, "tenantId", "accountId", "subjectId", "docType", "submissionId", status, "expiresOn", "recheckBy", "approvedBy", "approvedAt", "createdAt", "updatedAt")
SELECT gen_random_uuid(), u."tenantId", d."userId", d."subjectId", d."docType", d.id,
       (CASE d.state WHEN 'COMMITTED' THEN 'VALID' ELSE d.state::text END)::"DocumentRecordStatus",
       d."expiresAt", now() + interval '90 days', COALESCE(d."reviewedBy", 'system'), COALESCE(d."reviewedAt", d."updatedAt"), now(), now()
FROM verification_documents d JOIN users u ON u.id = d."userId"
WHERE d.state IN ('COMMITTED', 'EXPIRED', 'REVOKED', 'SUPERSEDED')
ON CONFLICT ("submissionId") DO NOTHING;
