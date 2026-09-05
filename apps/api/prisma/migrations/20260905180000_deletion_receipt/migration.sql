-- [DOC-1 §4.4 · DOC-INV-7] Deletion receipts.
--
-- Every purge of a PERSONAL document writes one, with a verification probe —
-- a real read attempt against every named store, recorded CONFIRMED_ABSENT or
-- FAILED. A receipt without a passing probe is not a receipt: the reaper
-- leaves the document due and retries; account erasure records the failure
-- and files the storage orphan for the retry sweep.
--
-- No FK to the document or the person: the receipt must outlive both — it is
-- what a regulator or a plaintiff's attorney is shown (DOC-1 S5).
-- Reconciled: content_sha256 is nullable (the spec says NOT NULL) because a
-- document whose bytes were already gone cannot be hashed; the receipt says so.

-- CreateTable
CREATE TABLE "deletion_receipt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "submissionId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "docTypeCode" TEXT NOT NULL,
    "contentSha256" BYTEA,
    "bytesDeleted" BIGINT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedBy" TEXT NOT NULL,
    "storeLocations" TEXT[],
    "verificationProbeResult" TEXT NOT NULL,

    CONSTRAINT "deletion_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deletion_receipt_submissionId_idx" ON "deletion_receipt"("submissionId");

-- CreateIndex
CREATE INDEX "deletion_receipt_subjectId_idx" ON "deletion_receipt"("subjectId");

-- CreateIndex
CREATE INDEX "deletion_receipt_tenantId_deletedAt_idx" ON "deletion_receipt"("tenantId", "deletedAt");

-- AddForeignKey
ALTER TABLE "deletion_receipt" ADD CONSTRAINT "deletion_receipt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Proof of purge is evidence about a person: walled like the person (enabled AND forced).
ALTER TABLE "deletion_receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deletion_receipt" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "deletion_receipt";
CREATE POLICY "tenant_isolation" ON "deletion_receipt"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- Append-only, like the audit trail: a receipt that can be edited proves nothing.
CREATE OR REPLACE FUNCTION deletion_receipt_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'deletion_receipt is append-only [DOC-INV-7]' USING ERRCODE = 'check_violation';
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS deletion_receipt_append_only ON deletion_receipt;
CREATE TRIGGER deletion_receipt_append_only BEFORE UPDATE OR DELETE ON deletion_receipt FOR EACH ROW EXECUTE FUNCTION deletion_receipt_append_only();
