-- Security-safe rollback for 20260909170000_verification_upload_authority.
-- Application intake must be disabled before this is run. Once a durable
-- claim exists, dropping this evidence would reopen OTA-030, so populated
-- tables deliberately refuse destructive rollback.
BEGIN;

ALTER TABLE "storage_orphans" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "verification_uploads" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "verification_documents" NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Legacy verification_documents and storage_orphans existed before this
  -- migration and are preserved when the added columns are dropped. Only a
  -- durable upload claim is new authority that rollback must never erase.
  IF EXISTS (SELECT 1 FROM "verification_uploads" LIMIT 1) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: verification upload authority exists; retain the expand schema and disable intake instead';
  END IF;
END $$;

DROP TRIGGER IF EXISTS storage_orphan_verification_authority_guard ON "storage_orphans";
DROP FUNCTION IF EXISTS storage_orphan_verification_authority_guard();
DROP TRIGGER IF EXISTS storage_orphan_identity_fill ON "storage_orphans";
DROP FUNCTION IF EXISTS storage_orphan_identity_fill();
DROP TRIGGER IF EXISTS verification_uploads_tenant_matches_user ON "verification_uploads";
DROP FUNCTION IF EXISTS verification_uploads_tenant_matches_user();
DROP TRIGGER IF EXISTS verification_upload_truncate_guard ON "verification_uploads";
DROP FUNCTION IF EXISTS verification_upload_truncate_guard();
DROP TRIGGER IF EXISTS doc_legal_hold_release_immutable_guard ON "doc_legal_hold";
DROP FUNCTION IF EXISTS doc_legal_hold_release_immutable_guard();
DROP TRIGGER IF EXISTS verification_upload_guard ON "verification_uploads";
DROP FUNCTION IF EXISTS verification_upload_guard();
DROP TRIGGER IF EXISTS verification_document_provenance_guard ON "verification_documents";
DROP FUNCTION IF EXISTS verification_document_provenance_guard();
DROP TRIGGER IF EXISTS verification_documents_tenant_matches_user ON "verification_documents";
DROP FUNCTION IF EXISTS verification_documents_tenant_matches_user();

ALTER TABLE "storage_orphans" DROP CONSTRAINT IF EXISTS "storage_orphans_verificationUploadId_fkey";
DROP INDEX IF EXISTS "storage_orphans_verificationUploadId_key";
DROP INDEX IF EXISTS "storage_orphans_objectIdentity_key";
DROP INDEX IF EXISTS "storage_orphans_storageLocationId_key_key";
DROP INDEX IF EXISTS "storage_orphans_purgedAt_quarantinedAt_nextAttemptAt_id_idx";
ALTER TABLE "storage_orphans"
  DROP COLUMN IF EXISTS "verificationUploadId",
  DROP COLUMN IF EXISTS "objectIdentity",
  DROP COLUMN IF EXISTS "storageLocationId",
  DROP COLUMN IF EXISTS "attempts",
  DROP COLUMN IF EXISTS "nextAttemptAt",
  DROP COLUMN IF EXISTS "lastAttemptAt",
  DROP COLUMN IF EXISTS "lastErrorCode",
  DROP COLUMN IF EXISTS "quarantinedAt",
  DROP COLUMN IF EXISTS "quarantineReason",
  DROP COLUMN IF EXISTS "confirmedAbsentAt";
ALTER TABLE "storage_orphans" FORCE ROW LEVEL SECURITY;

ALTER TABLE "verification_uploads"
  DROP CONSTRAINT IF EXISTS "verification_uploads_submission_tenant_user_fkey";
DROP TABLE "verification_uploads";
DROP POLICY IF EXISTS "tenant_isolation" ON "verification_documents";
ALTER TABLE "verification_documents" DISABLE ROW LEVEL SECURITY;
DROP INDEX IF EXISTS "verification_documents_storageProvenance_idx";
DROP INDEX IF EXISTS "verification_documents_tenantId_userId_idx";
DROP INDEX IF EXISTS "verification_documents_id_tenantId_userId_key";
ALTER TABLE "verification_documents"
  DROP CONSTRAINT IF EXISTS "verification_documents_storage_purge_facts_check";
ALTER TABLE "verification_documents"
  DROP CONSTRAINT IF EXISTS "verification_documents_tenantId_fkey";
ALTER TABLE "verification_documents"
  DROP COLUMN "tenantId",
  DROP COLUMN "storageProvenance",
  DROP COLUMN "verificationRoleKey",
  DROP COLUMN "storageAnomalyCode",
  DROP COLUMN "storageQuarantinedAt",
  DROP COLUMN "storagePurgeRequestedAt",
  DROP COLUMN "storagePurgeMode",
  DROP COLUMN "storagePurgeRequestedBy";
DROP TYPE "VerificationPurgeMode";
DROP TYPE "VerificationUploadState";
DROP TYPE "VerificationProcessingPolicy";
DROP TYPE "VerificationUploadPurpose";
DROP TYPE "VerificationStorageProvenance";

COMMIT;
