-- OTA-030 / REPORT-113: a client pointer is never object authority.
--
-- OFFLINE CUTOVER: application intake and every old binary must be stopped
-- before this migration starts, and traffic must not resume until the new
-- binary and a separately reviewed legacy reconciliation have completed.
-- This is deliberately not safe for a rolling deployment: an old writer does
-- not create purpose-bound upload authority.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- These tables are already FORCE RLS. The supported deploy identity is their
-- NOBYPASSRLS owner, so temporarily remove FORCE (not RLS) while deriving
-- tenant lineage and checking the complete legacy census. Transaction failure
-- restores every FORCE setting atomically.
ALTER TABLE "storage_orphans" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "document_record" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "vendors" NO FORCE ROW LEVEL SECURITY;

CREATE TYPE "VerificationStorageProvenance" AS ENUM ('UNVERIFIED', 'VERIFIED', 'QUARANTINED');
CREATE TYPE "VerificationUploadPurpose" AS ENUM ('CHECKLIST_DOCUMENT', 'IDENTITY_DOCUMENT', 'IDENTITY_SELFIE');
CREATE TYPE "VerificationProcessingPolicy" AS ENUM ('DOCUMENT_ONLY', 'FACE_MATCH');
CREATE TYPE "VerificationUploadState" AS ENUM ('UPLOADING', 'UPLOADED', 'PROCESSING', 'CONSUMED', 'EXPIRED', 'QUARANTINED', 'PURGE_PENDING', 'PURGED');
CREATE TYPE "VerificationPurgeMode" AS ENUM ('IMAGE_ONLY', 'FULL_RETENTION', 'FULL_ERASURE');

ALTER TABLE "verification_documents"
  ADD COLUMN "tenantId" TEXT,
  ADD COLUMN "storageProvenance" "VerificationStorageProvenance" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN "verificationRoleKey" TEXT,
  ADD COLUMN "storageAnomalyCode" TEXT,
  ADD COLUMN "storageQuarantinedAt" TIMESTAMP(3),
  ADD COLUMN "storagePurgeRequestedAt" TIMESTAMP(3),
  ADD COLUMN "storagePurgeMode" "VerificationPurgeMode",
  ADD COLUMN "storagePurgeRequestedBy" TEXT;

UPDATE "verification_documents" d
SET "tenantId" = u."tenantId"
FROM "users" u
WHERE u.id = d."userId";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "verification_documents" WHERE "tenantId" IS NULL) THEN
    RAISE EXCEPTION 'CUTOVER_PREFLIGHT_FAILED: a verification document has no owning user tenant';
  END IF;
  -- No destructive or blanket trust rewrite is legal inside this migration.
  -- Existing authority must first be reconciled per tenant by an independently
  -- reviewed operation with its own census and rollback evidence.
  IF EXISTS (
    SELECT 1 FROM "verification_documents"
    WHERE status = 'APPROVED'
       OR state IN ('AUTO_APPROVED', 'APPROVED', 'COMMITTED')
  ) OR EXISTS (
    SELECT 1 FROM "document_record" WHERE status = 'VALID'
  ) OR EXISTS (
    SELECT 1 FROM "users" WHERE "trustLevel" IN ('L2', 'L3')
  ) OR EXISTS (
    SELECT 1 FROM "riders" WHERE "documentsVerified" OR "isOnline"
  ) OR EXISTS (
    SELECT 1 FROM "drivers" WHERE "documentsVerified" OR "isOnline"
  ) OR EXISTS (
    SELECT 1 FROM "vendors" WHERE "isVerified" OR "acceptingOrders"
  ) OR EXISTS (
    SELECT 1 FROM "service_providers" WHERE "isVerified"
  ) THEN
    RAISE EXCEPTION 'CUTOVER_PREFLIGHT_FAILED: legacy verification projections require audited tenant-scoped reconciliation';
  END IF;
END $$;

ALTER TABLE "verification_documents"
  ALTER COLUMN "tenantId" SET DEFAULT 'swift-default',
  ALTER COLUMN "tenantId" SET NOT NULL,
  ADD CONSTRAINT "verification_documents_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "verification_documents"
  ADD CONSTRAINT "verification_documents_storage_purge_facts_check" CHECK (
    ("storagePurgeRequestedAt" IS NULL AND "storagePurgeMode" IS NULL AND "storagePurgeRequestedBy" IS NULL)
    OR
    ("storagePurgeRequestedAt" IS NOT NULL AND "storagePurgeMode" IS NOT NULL AND "storagePurgeRequestedBy" IS NOT NULL)
  );

CREATE INDEX "verification_documents_storageProvenance_idx"
  ON "verification_documents"("storageProvenance");
CREATE INDEX "verification_documents_tenantId_userId_idx"
  ON "verification_documents"("tenantId", "userId");
CREATE UNIQUE INDEX "verification_documents_id_tenantId_userId_key"
  ON "verification_documents"(id, "tenantId", "userId");

CREATE TABLE "verification_uploads" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
  "userId" TEXT NOT NULL,
  "storageLocationId" TEXT NOT NULL,
  "providerKey" TEXT NOT NULL,
  "canonicalKey" TEXT NOT NULL,
  "objectVersion" TEXT,
  "purpose" "VerificationUploadPurpose" NOT NULL,
  "roleKey" TEXT,
  "docType" TEXT,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "encrypted" BOOLEAN NOT NULL DEFAULT false,
  "state" "VerificationUploadState" NOT NULL DEFAULT 'UPLOADING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "processingId" UUID,
  "processingStartedAt" TIMESTAMP(3),
  "processingPolicy" "VerificationProcessingPolicy",
  "submissionId" TEXT,
  "consumedAt" TIMESTAMP(3),
  "quarantineReason" TEXT,
  "quarantinedAt" TIMESTAMP(3),
  "purgeRequestedAt" TIMESTAMP(3),
  "purgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "verification_uploads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verification_uploads_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "verification_uploads_size_check" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 5242880),
  CONSTRAINT "verification_uploads_object_version_check" CHECK (
    (state = 'UPLOADING' AND "objectVersion" IS NULL)
    OR (state = 'QUARANTINED' AND ("objectVersion" IS NULL OR length("objectVersion") > 0))
    OR (state NOT IN ('UPLOADING', 'QUARANTINED') AND "objectVersion" IS NOT NULL AND length("objectVersion") > 0)
  ),
  CONSTRAINT "verification_uploads_key_check" CHECK (
    "canonicalKey" ~ '^verification/[^/\\?#%]+/[^/\\?#%]+$'
    AND split_part("canonicalKey", '/', 2) = "userId"
    AND "providerKey" IN ("canonicalKey", 'uploads/' || "canonicalKey", '/uploads/' || "canonicalKey")
    AND length("storageLocationId") > 0
  ),
  CONSTRAINT "verification_uploads_purpose_check" CHECK (
    ("purpose" = 'CHECKLIST_DOCUMENT' AND "roleKey" IS NOT NULL AND "docType" IS NOT NULL)
    OR ("purpose" = 'IDENTITY_DOCUMENT' AND "roleKey" = 'CUSTOMER' AND "docType" = 'identity_l2')
    OR ("purpose" = 'IDENTITY_SELFIE' AND "roleKey" IS NOT NULL AND "docType" IS NULL)
  ),
  CONSTRAINT "verification_uploads_role_key_check" CHECK (
    "roleKey" IS NULL OR "roleKey" IN ('CUSTOMER', 'MOVER', 'RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE', 'SERVICE_PROVIDER')
  ),
  CONSTRAINT "verification_uploads_selfie_mime_check" CHECK (
    "purpose" <> 'IDENTITY_SELFIE'
    OR "mimeType" IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  CONSTRAINT "verification_uploads_processing_check" CHECK (
    "state" <> 'PROCESSING' OR ("processingId" IS NOT NULL AND "processingStartedAt" IS NOT NULL AND "processingPolicy" IS NOT NULL)
  ),
  CONSTRAINT "verification_uploads_consumed_check" CHECK (
    "state" <> 'CONSUMED' OR ("processingId" IS NOT NULL AND "processingStartedAt" IS NOT NULL AND "processingPolicy" IS NOT NULL AND "submissionId" IS NOT NULL AND "consumedAt" IS NOT NULL)
  ),
  CONSTRAINT "verification_uploads_quarantine_check" CHECK (
    "state" <> 'QUARANTINED' OR ("quarantineReason" IS NOT NULL AND "quarantinedAt" IS NOT NULL)
  ),
  CONSTRAINT "verification_uploads_purged_check" CHECK (
    "state" <> 'PURGED' OR "purgedAt" IS NOT NULL
  ),
  CONSTRAINT "verification_uploads_purge_request_check" CHECK (
    ("state" IN ('PURGE_PENDING', 'PURGED') AND "purgeRequestedAt" IS NOT NULL)
    OR
    ("state" NOT IN ('PURGE_PENDING', 'PURGED') AND "purgeRequestedAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "verification_uploads_storageLocationId_providerKey_key"
  ON "verification_uploads"("storageLocationId", "providerKey");
CREATE UNIQUE INDEX "verification_uploads_storageLocationId_canonicalKey_key"
  ON "verification_uploads"("storageLocationId", "canonicalKey");
CREATE UNIQUE INDEX "verification_uploads_submissionId_purpose_key"
  ON "verification_uploads"("submissionId", "purpose");
CREATE INDEX "verification_uploads_tenantId_userId_state_expiresAt_id_idx"
  ON "verification_uploads"("tenantId", "userId", "state", "expiresAt", "id");
CREATE INDEX "verification_uploads_state_expiresAt_id_idx"
  ON "verification_uploads"("state", "expiresAt", "id");
CREATE INDEX "verification_uploads_submissionId_idx"
  ON "verification_uploads"("submissionId");

ALTER TABLE "verification_uploads"
  ADD CONSTRAINT "verification_uploads_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "verification_uploads_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "verification_uploads_submissionId_fkey"
    FOREIGN KEY ("submissionId") REFERENCES "verification_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "verification_uploads"
  ADD CONSTRAINT "verification_uploads_submission_tenant_user_fkey"
    FOREIGN KEY ("submissionId", "tenantId", "userId")
    REFERENCES "verification_documents"("id", "tenantId", "userId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "storage_orphans"
  ADD COLUMN "verificationUploadId" UUID,
  ADD COLUMN "objectIdentity" TEXT,
  ADD COLUMN "storageLocationId" TEXT,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "quarantinedAt" TIMESTAMP(3),
  ADD COLUMN "quarantineReason" TEXT,
  ADD COLUMN "confirmedAbsentAt" TIMESTAMP(3);

UPDATE "storage_orphans"
SET "objectIdentity" = 'legacy:' || key;
CREATE OR REPLACE FUNCTION storage_orphan_identity_fill() RETURNS trigger AS $$
DECLARE
  upload_location TEXT;
  upload_key TEXT;
  upload_version TEXT;
BEGIN
  IF NEW."objectIdentity" IS NULL THEN
    IF NEW."verificationUploadId" IS NOT NULL THEN
      SELECT u."storageLocationId", u."providerKey", u."objectVersion"
        INTO upload_location, upload_key, upload_version
      FROM public.verification_uploads u
      WHERE u.id = NEW."verificationUploadId";
      IF upload_location IS NOT NULL AND upload_key IS NOT NULL AND upload_version IS NOT NULL THEN
        NEW."objectIdentity" := 'v1:'
          || length(upload_location)::text || ':' || upload_location || ':'
          || length(upload_key)::text || ':' || upload_key || ':'
          || length(upload_version)::text || ':' || upload_version;
      END IF;
    ELSE
      NEW."objectIdentity" := CASE
        WHEN NEW."storageLocationId" IS NULL THEN 'legacy:' || NEW.key
        ELSE length(NEW."storageLocationId")::text || ':' || NEW."storageLocationId" || NEW.key
      END;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS storage_orphan_identity_fill ON "storage_orphans";
CREATE TRIGGER storage_orphan_identity_fill
BEFORE INSERT OR UPDATE OF key, "storageLocationId", "objectIdentity" ON "storage_orphans"
FOR EACH ROW EXECUTE FUNCTION storage_orphan_identity_fill();
ALTER TABLE "storage_orphans" ALTER COLUMN "objectIdentity" SET NOT NULL;

-- Keep the legacy key uniqueness during the offline cutover because avatar
-- orphan writers still use ON CONFLICT(key). Verification claims use the
-- generation-bound objectIdentity and never fall back to a path-shaped key.
CREATE UNIQUE INDEX "storage_orphans_objectIdentity_key"
  ON "storage_orphans"("objectIdentity");
CREATE UNIQUE INDEX "storage_orphans_verificationUploadId_key"
  ON "storage_orphans"("verificationUploadId");
CREATE UNIQUE INDEX "storage_orphans_storageLocationId_key_key"
  ON "storage_orphans"("storageLocationId", "key");
CREATE INDEX "storage_orphans_purgedAt_quarantinedAt_nextAttemptAt_id_idx"
  ON "storage_orphans"("purgedAt", "quarantinedAt", "nextAttemptAt", "id");
ALTER TABLE "storage_orphans"
  ADD CONSTRAINT "storage_orphans_verificationUploadId_fkey"
    FOREIGN KEY ("verificationUploadId") REFERENCES "verification_uploads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A fresh approval is authority-bearing. Refuse it at the database boundary
-- unless the application atomically consumed server-issued upload claims.
CREATE OR REPLACE FUNCTION verification_document_provenance_guard() RETURNS trigger AS $$
DECLARE
  primary_claim RECORD;
  attached_count INTEGER;
  selfie_count INTEGER;
  old_trusted BOOLEAN := false;
  new_trusted BOOLEAN;
  must_validate BOOLEAN := false;
BEGIN
  new_trusted := NEW.state IN ('AUTO_APPROVED', 'APPROVED', 'COMMITTED') OR NEW.status = 'APPROVED';
  IF TG_OP = 'UPDATE' THEN
    old_trusted := OLD.state IN ('AUTO_APPROVED', 'APPROVED', 'COMMITTED') OR OLD.status = 'APPROVED';
    IF NEW."storageProvenance" IS DISTINCT FROM OLD."storageProvenance" THEN
      IF NOT (
        (OLD."storageProvenance" = 'UNVERIFIED' AND NEW."storageProvenance" IN ('VERIFIED', 'QUARANTINED'))
        OR (OLD."storageProvenance" = 'VERIFIED' AND NEW."storageProvenance" = 'QUARANTINED')
      ) THEN
        RAISE EXCEPTION 'DOCUMENT_PROVENANCE_IMMUTABLE: provenance may only verify once or enter quarantine'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."storageProvenance" = 'QUARANTINED' THEN
        IF NEW."storageAnomalyCode" IS NULL OR NEW."storageQuarantinedAt" IS NULL THEN
          RAISE EXCEPTION 'DOCUMENT_PROVENANCE_INVALID: quarantine requires immutable anomaly facts'
            USING ERRCODE = 'check_violation';
        END IF;
        -- Demotion is an explicit state-machine operation. Provenance cannot
        -- silently rewrite a decision or invent a transition on the caller's
        -- behalf: AUTO_APPROVED first returns to review; APPROVED first commits
        -- and revokes; COMMITTED first revokes.
        IF old_trusted OR new_trusted THEN
          RAISE EXCEPTION 'DOCUMENT_PROVENANCE_DEMOTION_REQUIRED: leave every trusted state before quarantine'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    IF NEW."storageProvenance" = 'QUARANTINED' THEN
      IF NEW."storageAnomalyCode" IS NULL OR NEW."storageQuarantinedAt" IS NULL THEN
        RAISE EXCEPTION 'DOCUMENT_PROVENANCE_INVALID: quarantine facts are incomplete'
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."storageProvenance" = 'QUARANTINED' AND (
        NEW."storageAnomalyCode" IS DISTINCT FROM OLD."storageAnomalyCode"
        OR NEW."storageQuarantinedAt" IS DISTINCT FROM OLD."storageQuarantinedAt"
      ) THEN
        RAISE EXCEPTION 'DOCUMENT_PROVENANCE_IMMUTABLE: quarantine facts cannot change'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."storageAnomalyCode" IS NOT NULL OR NEW."storageQuarantinedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'DOCUMENT_PROVENANCE_INVALID: anomaly facts require quarantine'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."storageProvenance" = 'VERIFIED' OR old_trusted) AND (
      NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
      OR NEW."userId" IS DISTINCT FROM OLD."userId"
      OR NEW."docType" IS DISTINCT FROM OLD."docType"
      OR NEW.role IS DISTINCT FROM OLD.role
      OR NEW."verificationRoleKey" IS DISTINCT FROM OLD."verificationRoleKey"
    ) THEN
      RAISE EXCEPTION 'DOCUMENT_PROVENANCE_IMMUTABLE: trusted document authority cannot change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."storageProvenance" = 'VERIFIED' OR old_trusted)
       AND NEW."fileUrl" IS DISTINCT FROM OLD."fileUrl"
       AND NOT (
         OLD."fileUrl" <> '' AND NEW."fileUrl" = ''
         AND NEW."storagePurgeRequestedAt" IS NOT NULL
         AND NEW."legalHoldId" IS NULL
         AND (
           (OLD."imagePurgedAt" IS NULL AND NEW."imagePurgedAt" IS NOT NULL AND NEW."storagePurgeMode" = 'IMAGE_ONLY')
           OR
           (OLD."purgedAt" IS NULL AND NEW."purgedAt" IS NOT NULL AND NEW."storagePurgeMode" IN ('FULL_RETENTION', 'FULL_ERASURE'))
         )
       ) THEN
      RAISE EXCEPTION 'DOCUMENT_PROVENANCE_IMMUTABLE: a storage pointer may only be cleared after purge'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."imagePurgedAt" IS DISTINCT FROM OLD."imagePurgedAt" AND NOT (
      OLD."imagePurgedAt" IS NULL
      AND NEW."imagePurgedAt" IS NOT NULL
      AND NEW."storagePurgeRequestedAt" IS NOT NULL
      AND NEW."storagePurgeMode" = 'IMAGE_ONLY'
      AND NEW."legalHoldId" IS NULL
      AND NEW."fileUrl" = ''
      AND EXISTS (
        SELECT 1 FROM public.deletion_receipt r
        WHERE r."submissionId" = NEW.id
          AND r."subjectId" = NEW."userId"
          AND r."docTypeCode" = NEW."docType"
          AND r."verificationProbeResult" = 'CONFIRMED_ABSENT'
          AND r."deletedAt" >= NEW."storagePurgeRequestedAt"
          AND EXISTS (
            SELECT 1 FROM public.verification_uploads u
            WHERE u."submissionId" = NEW.id
              AND u.state = 'PURGE_PENDING'
              AND u."purgeRequestedAt" = NEW."storagePurgeRequestedAt"
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.verification_uploads u
            WHERE u."submissionId" = NEW.id
              AND NOT (r."storeLocations" @> ARRAY[
                'object:v1:'
                || length(u."storageLocationId")::text || ':' || u."storageLocationId" || ':'
                || length(u."providerKey")::text || ':' || u."providerKey" || ':'
                || length(u."objectVersion")::text || ':' || u."objectVersion"
              ]::text[])
          )
      )
    ) THEN
      RAISE EXCEPTION 'DOCUMENT_PURGE_MARKER_INVALID: image purge confirmation is monotonic and authority-bound'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."purgedAt" IS DISTINCT FROM OLD."purgedAt" AND NOT (
      OLD."purgedAt" IS NULL
      AND NEW."purgedAt" IS NOT NULL
      AND NEW."storagePurgeRequestedAt" IS NOT NULL
      AND NEW."storagePurgeMode" IN ('FULL_RETENTION', 'FULL_ERASURE')
      AND NEW."legalHoldId" IS NULL
      AND NEW."fileUrl" = ''
      AND EXISTS (
        SELECT 1 FROM public.deletion_receipt r
        WHERE r."submissionId" = NEW.id
          AND r."subjectId" = NEW."userId"
          AND r."docTypeCode" = NEW."docType"
          AND r."verificationProbeResult" = 'CONFIRMED_ABSENT'
          AND r."deletedAt" >= NEW."storagePurgeRequestedAt"
          AND EXISTS (
            SELECT 1 FROM public.verification_uploads u
            WHERE u."submissionId" = NEW.id
              AND u.state = 'PURGE_PENDING'
              AND u."purgeRequestedAt" = NEW."storagePurgeRequestedAt"
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.verification_uploads u
            WHERE u."submissionId" = NEW.id
              AND NOT (r."storeLocations" @> ARRAY[
                'object:v1:'
                || length(u."storageLocationId")::text || ':' || u."storageLocationId" || ':'
                || length(u."providerKey")::text || ':' || u."providerKey" || ':'
                || length(u."objectVersion")::text || ':' || u."objectVersion"
              ]::text[])
          )
      )
    ) THEN
      RAISE EXCEPTION 'DOCUMENT_PURGE_MARKER_INVALID: submission purge confirmation is monotonic and authority-bound'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."legalHoldId" IS NOT NULL AND OLD."legalHoldId" IS NULL
       AND NEW."storagePurgeRequestedAt" IS NOT NULL
       AND NOT (
         NEW."storagePurgeMode" = 'IMAGE_ONLY'
         AND NEW."imagePurgedAt" IS NOT NULL
         AND NEW."purgedAt" IS NULL
       ) THEN
      RAISE EXCEPTION 'DOCUMENT_PURGE_AUTHORITY_INVALID: a legal hold cannot be placed after storage purge authorization'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."storagePurgeRequestedAt" IS DISTINCT FROM OLD."storagePurgeRequestedAt" THEN
      IF NOT (
        OLD."storagePurgeRequestedAt" IS NULL
        AND OLD."storagePurgeMode" IS NULL
        AND OLD."storagePurgeRequestedBy" IS NULL
        AND NEW."storagePurgeRequestedAt" IS NOT NULL
        AND NEW."storagePurgeMode" IS NOT NULL
        AND NEW."storagePurgeRequestedBy" IS NOT NULL
        AND NEW."legalHoldId" IS NULL
      ) THEN
        RAISE EXCEPTION 'DOCUMENT_PURGE_AUTHORITY_INVALID: purge authorization is one-time and cannot coexist with a legal hold'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."storagePurgeMode" IS DISTINCT FROM OLD."storagePurgeMode"
       OR NEW."storagePurgeRequestedBy" IS DISTINCT FROM OLD."storagePurgeRequestedBy" THEN
      IF NOT (
        OLD."storagePurgeRequestedAt" IS NOT NULL
        AND NEW."storagePurgeRequestedAt" = OLD."storagePurgeRequestedAt"
        AND NEW."legalHoldId" IS NULL
        AND NEW."storagePurgeRequestedBy" IS NOT NULL
        AND CASE OLD."storagePurgeMode"
          WHEN 'IMAGE_ONLY' THEN NEW."storagePurgeMode" IN ('FULL_RETENTION', 'FULL_ERASURE')
          WHEN 'FULL_RETENTION' THEN NEW."storagePurgeMode" = 'FULL_ERASURE'
          ELSE false
        END
      ) THEN
        RAISE EXCEPTION 'DOCUMENT_PURGE_AUTHORITY_INVALID: purge mode may only escalate'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    must_validate := NEW."storageProvenance" = 'VERIFIED' AND (
      OLD."storageProvenance" IS DISTINCT FROM 'VERIFIED'
      OR (new_trusted AND NOT old_trusted)
    );
  ELSE
    IF NEW."storageProvenance" <> 'UNVERIFIED'
       OR NEW."storageAnomalyCode" IS NOT NULL
       OR NEW."storageQuarantinedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'DOCUMENT_PROVENANCE_INVALID: a new document must begin unverified with no anomaly facts'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."storagePurgeRequestedAt" IS NOT NULL
       OR NEW."storagePurgeMode" IS NOT NULL
       OR NEW."storagePurgeRequestedBy" IS NOT NULL
       OR NEW."imagePurgedAt" IS NOT NULL
       OR NEW."purgedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'DOCUMENT_PURGE_AUTHORITY_INVALID: a new document cannot be born with purge authority or confirmation'
        USING ERRCODE = 'check_violation';
    END IF;
    must_validate := NEW."storageProvenance" = 'VERIFIED';
  END IF;

  IF must_validate THEN
    SELECT u."processingId", u."processingPolicy", u."roleKey", u."docType", u.sha256, u."canonicalKey", u.state
      INTO primary_claim
    FROM public.verification_uploads u
    WHERE u."submissionId" = NEW.id
      AND u."userId" = NEW."userId"
      AND u."tenantId" = NEW."tenantId"
      AND (
        (NEW."fileUrl" <> '' AND u."providerKey" = NEW."fileUrl")
        OR (NEW."fileUrl" = '' AND (NEW."imagePurgedAt" IS NOT NULL OR NEW."purgedAt" IS NOT NULL))
      )
      AND u."roleKey" = NEW."verificationRoleKey"
      AND u."docType" = NEW."docType"
      AND (
        u.state = 'CONSUMED'
        OR (u.state = 'PURGE_PENDING' AND NEW."storagePurgeRequestedAt" IS NOT NULL)
        OR (u.state = 'PURGED' AND (NEW."imagePurgedAt" IS NOT NULL OR NEW."purgedAt" IS NOT NULL))
      )
      AND (
        (NEW."docType" = 'identity_l2' AND u.purpose = 'IDENTITY_DOCUMENT')
        OR (NEW."docType" <> 'identity_l2' AND u.purpose = 'CHECKLIST_DOCUMENT')
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'DOCUMENT_PROVENANCE_INVALID: document % has no exact consumed primary authority', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.role <> (CASE
      WHEN primary_claim."roleKey" = 'MOVER' THEN 'MOVER'::"UserRole"
      WHEN primary_claim."roleKey" = 'SERVICE_PROVIDER' OR primary_claim."roleKey" = 'CUSTOMER' THEN 'CUSTOMER'::"UserRole"
      ELSE 'VENDOR_OWNER'::"UserRole"
    END) THEN
      RAISE EXCEPTION 'DOCUMENT_PROVENANCE_INVALID: authority role does not match document role projection'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO attached_count
    FROM public.verification_uploads u
    WHERE u."submissionId" = NEW.id;
    IF primary_claim."processingPolicy" = 'DOCUMENT_ONLY' THEN
      IF attached_count <> 1 THEN
        RAISE EXCEPTION 'DOCUMENT_PROVENANCE_INVALID: document-only authority % has an unexpected claim set', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF primary_claim."processingPolicy" = 'FACE_MATCH' THEN
      SELECT count(*) INTO selfie_count
      FROM public.verification_uploads u
      WHERE u."submissionId" = NEW.id
        AND u."userId" = NEW."userId"
        AND u.purpose = 'IDENTITY_SELFIE'
        AND u."roleKey" = NEW."verificationRoleKey"
        AND u."docType" IS NULL
        AND u."processingId" = primary_claim."processingId"
        AND u."processingPolicy" = primary_claim."processingPolicy"
        AND (
          u.state = 'CONSUMED'
          OR (u.state = 'PURGE_PENDING' AND NEW."storagePurgeRequestedAt" IS NOT NULL)
          OR (u.state = 'PURGED' AND (NEW."imagePurgedAt" IS NOT NULL OR NEW."purgedAt" IS NOT NULL))
        )
        AND u.sha256 <> primary_claim.sha256
        AND u."canonicalKey" <> primary_claim."canonicalKey";
      IF attached_count <> 2 OR selfie_count <> 1 THEN
        RAISE EXCEPTION 'DOCUMENT_PROVENANCE_INVALID: face-match authority % is not one exact document/selfie pair', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'DOCUMENT_PROVENANCE_INVALID: document % has no sealed processing policy', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF new_trusted AND NEW."storageProvenance" <> 'VERIFIED' THEN
    RAISE EXCEPTION 'DOCUMENT_PROVENANCE_INVALID: document % cannot retain or create trust from unverified storage', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION verification_document_provenance_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS verification_document_provenance_guard ON "verification_documents";
CREATE TRIGGER verification_document_provenance_guard
BEFORE INSERT OR UPDATE OF state, status, "storageProvenance", "storageAnomalyCode", "storageQuarantinedAt", "tenantId", "userId", "fileUrl", "docType", role, "verificationRoleKey", "storagePurgeRequestedAt", "storagePurgeMode", "storagePurgeRequestedBy", "legalHoldId", "imagePurgedAt", "purgedAt" ON "verification_documents"
FOR EACH ROW EXECUTE FUNCTION verification_document_provenance_guard();

-- Immutable upload identity and a small, explicit lifecycle. A caller may
-- advance operational state; it may never rewrite whose bytes these were.
CREATE OR REPLACE FUNCTION verification_upload_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_APPEND_ONLY: authority tombstones cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'UPLOADING'
       OR NEW."objectVersion" IS NOT NULL
       OR NEW."expiresAt" <= CURRENT_TIMESTAMP
       OR NEW."processingId" IS NOT NULL OR NEW."processingStartedAt" IS NOT NULL OR NEW."processingPolicy" IS NOT NULL
       OR NEW."submissionId" IS NOT NULL OR NEW."consumedAt" IS NOT NULL
       OR NEW."quarantineReason" IS NOT NULL OR NEW."quarantinedAt" IS NOT NULL
       OR NEW."purgeRequestedAt" IS NOT NULL OR NEW."purgedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'VERIFICATION_UPLOAD_INSERT_INVALID: new authority must begin UPLOADING with no lifecycle facts'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (
    NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."storageLocationId" IS DISTINCT FROM OLD."storageLocationId"
    OR NEW."providerKey" IS DISTINCT FROM OLD."providerKey"
    OR NEW."canonicalKey" IS DISTINCT FROM OLD."canonicalKey"
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW."roleKey" IS DISTINCT FROM OLD."roleKey"
    OR NEW."docType" IS DISTINCT FROM OLD."docType"
    OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType"
    OR NEW."sizeBytes" IS DISTINCT FROM OLD."sizeBytes"
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.encrypted IS DISTINCT FROM OLD.encrypted
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_IMMUTABLE: upload identity cannot change'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'UPLOADING' AND NEW.state IN ('UPLOADED', 'QUARANTINED'))
    OR (OLD.state = 'UPLOADED' AND NEW.state IN ('PROCESSING', 'EXPIRED', 'PURGE_PENDING', 'QUARANTINED'))
    OR (OLD.state = 'PROCESSING' AND NEW.state IN ('CONSUMED', 'PURGE_PENDING', 'QUARANTINED'))
    OR (OLD.state = 'CONSUMED' AND NEW.state IN ('PURGE_PENDING', 'QUARANTINED'))
    OR (OLD.state = 'EXPIRED' AND NEW.state IN ('PURGE_PENDING', 'QUARANTINED'))
    OR (OLD.state = 'PURGE_PENDING' AND NEW.state = 'PURGED')
    OR (OLD.state = 'QUARANTINED' AND NEW.state = 'PURGE_PENDING' AND OLD."objectVersion" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_STATE_INVALID: % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'UPLOADED' AND NEW.state = 'PROCESSING'
     AND NEW."expiresAt" <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_EXPIRED: expired upload authority cannot begin processing'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."objectVersion" IS DISTINCT FROM OLD."objectVersion" AND NOT (
    OLD.state = 'UPLOADING' AND NEW.state = 'UPLOADED'
    AND OLD."objectVersion" IS NULL
    AND NEW."objectVersion" IS NOT NULL
    AND length(NEW."objectVersion") > 0
  ) THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_GENERATION_IMMUTABLE: provider generation may only be sealed once'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state NOT IN ('UPLOADING', 'QUARANTINED')
     AND (NEW."objectVersion" IS NULL OR length(NEW."objectVersion") = 0) THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_GENERATION_REQUIRED: lifecycle authority requires an exact provider generation'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every transition of an attached claim takes the document row lock. This
  -- serializes quarantine/purge with the document's provenance seal.
  IF OLD."submissionId" IS NOT NULL AND NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM 1 FROM public.verification_documents d
    WHERE d.id = OLD."submissionId" FOR UPDATE;
  END IF;

  IF (NEW."processingId", NEW."processingStartedAt", NEW."processingPolicy")
     IS DISTINCT FROM (OLD."processingId", OLD."processingStartedAt", OLD."processingPolicy")
     AND NOT (
       OLD.state = 'UPLOADED' AND NEW.state = 'PROCESSING'
       AND OLD."processingId" IS NULL AND OLD."processingStartedAt" IS NULL AND OLD."processingPolicy" IS NULL
       AND NEW."processingId" IS NOT NULL AND NEW."processingStartedAt" IS NOT NULL AND NEW."processingPolicy" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_LIFECYCLE_INVALID: processing authority is one-time'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."submissionId", NEW."consumedAt") IS DISTINCT FROM (OLD."submissionId", OLD."consumedAt")
     AND NOT (
       OLD.state = 'PROCESSING' AND NEW.state = 'CONSUMED'
       AND OLD."submissionId" IS NULL AND OLD."consumedAt" IS NULL
       AND NEW."submissionId" IS NOT NULL AND NEW."consumedAt" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_LIFECYCLE_INVALID: consumption binding is one-time'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'PROCESSING' AND NEW.state = 'CONSUMED' THEN
    -- The common-row lock above (or this first attachment lock) closes the
    -- cross-table write-skew window with UNVERIFIED -> VERIFIED.
    PERFORM 1 FROM public.verification_documents d
    WHERE d.id = NEW."submissionId" FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM public.verification_documents d
      WHERE d.id = NEW."submissionId" AND d."storageProvenance" = 'VERIFIED'
    ) THEN
      RAISE EXCEPTION 'VERIFICATION_UPLOAD_SET_SEALED: claims cannot be added to verified authority'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."quarantineReason", NEW."quarantinedAt") IS DISTINCT FROM (OLD."quarantineReason", OLD."quarantinedAt")
     AND NOT (
       NEW.state = 'QUARANTINED' AND OLD.state <> 'QUARANTINED'
       AND OLD."quarantineReason" IS NULL AND OLD."quarantinedAt" IS NULL
       AND NEW."quarantineReason" IS NOT NULL AND NEW."quarantinedAt" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_LIFECYCLE_INVALID: quarantine facts are one-time'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purgeRequestedAt" IS DISTINCT FROM OLD."purgeRequestedAt"
     AND NOT (
       NEW.state = 'PURGE_PENDING' AND OLD.state <> 'PURGE_PENDING'
       AND OLD."purgeRequestedAt" IS NULL AND NEW."purgeRequestedAt" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_LIFECYCLE_INVALID: purge request is one-time'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purgedAt" IS DISTINCT FROM OLD."purgedAt"
     AND NOT (
       OLD.state = 'PURGE_PENDING' AND NEW.state = 'PURGED'
       AND OLD."purgedAt" IS NULL AND NEW."purgedAt" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_LIFECYCLE_INVALID: purge confirmation is one-time'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'QUARANTINED' AND OLD."submissionId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.verification_documents d
    WHERE d.id = OLD."submissionId" AND d."storageProvenance" = 'VERIFIED'
  ) THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_QUARANTINE_ORDER: quarantine the document before its consumed authority'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'PURGE_PENDING' AND OLD.state <> 'PURGE_PENDING'
     AND OLD."submissionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.verification_documents d
    WHERE d.id = OLD."submissionId"
      AND d."storageProvenance" IN ('VERIFIED', 'QUARANTINED')
      AND d."storagePurgeRequestedAt" IS NOT NULL
      AND d."legalHoldId" IS NULL
  ) THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_PURGE_ORDER: authorize purge on an unlocked document before leaving consumed state'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'PURGE_PENDING' AND NEW.state = 'PURGED'
     AND OLD."submissionId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.verification_documents d
       WHERE d.id = OLD."submissionId"
         AND (d."imagePurgedAt" IS NOT NULL OR d."purgedAt" IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'VERIFICATION_UPLOAD_PURGE_ORDER: mark the document purge before closing its object authority'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'PURGE_PENDING' AND NEW.state = 'PURGED' THEN
    IF OLD."submissionId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.deletion_receipt r
      WHERE r."submissionId" = OLD."submissionId"
        AND r."verificationProbeResult" = 'CONFIRMED_ABSENT'
        AND r."deletedAt" >= OLD."purgeRequestedAt"
        AND r."storeLocations" @> ARRAY[
          'object:v1:'
          || length(OLD."storageLocationId")::text || ':' || OLD."storageLocationId" || ':'
          || length(OLD."providerKey")::text || ':' || OLD."providerKey" || ':'
          || length(OLD."objectVersion")::text || ':' || OLD."objectVersion"
        ]::text[]
    ) THEN
      RAISE EXCEPTION 'VERIFICATION_UPLOAD_PURGE_EVIDENCE: attached authority needs an exact confirmed-absent receipt'
        USING ERRCODE = 'check_violation';
    ELSIF OLD."submissionId" IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.storage_orphans o
      WHERE o."verificationUploadId" = OLD.id
        AND o."confirmedAbsentAt" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'VERIFICATION_UPLOAD_PURGE_EVIDENCE: unattached authority needs a confirmed-absent retry record'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION verification_upload_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS verification_upload_guard ON "verification_uploads";
CREATE TRIGGER verification_upload_guard
BEFORE INSERT OR UPDATE OR DELETE ON "verification_uploads"
FOR EACH ROW EXECUTE FUNCTION verification_upload_guard();

CREATE OR REPLACE FUNCTION verification_upload_truncate_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'VERIFICATION_UPLOAD_APPEND_ONLY: authority tombstones cannot be truncated'
    USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION verification_upload_truncate_guard() FROM PUBLIC;
CREATE TRIGGER verification_upload_truncate_guard
BEFORE TRUNCATE ON "verification_uploads"
FOR EACH STATEMENT EXECUTE FUNCTION verification_upload_truncate_guard();

-- A release is one consequential audit decision. Once written, its actor,
-- reason and timestamp are evidence and may never be cleared or replaced.
CREATE OR REPLACE FUNCTION doc_legal_hold_release_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."releasedAt" IS NOT NULL AND (
    NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt"
    OR NEW."releasedBy" IS DISTINCT FROM OLD."releasedBy"
    OR NEW."releaseReason" IS DISTINCT FROM OLD."releaseReason"
  ) THEN
    RAISE EXCEPTION 'DOC_LEGAL_HOLD_RELEASE_IMMUTABLE: release evidence cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."releasedAt" IS NULL AND NEW."releasedAt" IS NOT NULL
     AND (NEW."releasedBy" IS NULL OR NEW."releaseReason" IS NULL) THEN
    RAISE EXCEPTION 'DOC_LEGAL_HOLD_RELEASE_INVALID: release requires actor and reason'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION doc_legal_hold_release_immutable_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS doc_legal_hold_release_immutable_guard ON "doc_legal_hold";
CREATE TRIGGER doc_legal_hold_release_immutable_guard
BEFORE UPDATE OF "releasedAt", "releasedBy", "releaseReason" ON "doc_legal_hold"
FOR EACH ROW EXECUTE FUNCTION doc_legal_hold_release_immutable_guard();

-- A retry row is scheduling state, never deletion authority by itself. New
-- verification orphans must exactly mirror an immutable upload claim; legacy
-- or unprovable rows remain quarantined and never reach a provider.
CREATE OR REPLACE FUNCTION storage_orphan_verification_authority_guard() RETURNS trigger AS $$
DECLARE
  upload_row RECORD;
  confirmed_closure BOOLEAN := false;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."verificationUploadId" IS NOT NULL AND (
    NEW."verificationUploadId" IS DISTINCT FROM OLD."verificationUploadId"
    OR NEW."objectIdentity" IS DISTINCT FROM OLD."objectIdentity"
    OR NEW."storageLocationId" IS DISTINCT FROM OLD."storageLocationId"
    OR NEW.key IS DISTINCT FROM OLD.key
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
  ) THEN
    RAISE EXCEPTION 'STORAGE_ORPHAN_AUTHORITY_IMMUTABLE: linked deletion identity cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."verificationUploadId" IS NOT NULL THEN
    IF OLD."confirmedAbsentAt" IS NOT NULL
       AND NEW."confirmedAbsentAt" IS DISTINCT FROM OLD."confirmedAbsentAt" THEN
      RAISE EXCEPTION 'STORAGE_ORPHAN_CLOSURE_IMMUTABLE: confirmed absence cannot be cleared or rewritten'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."purgedAt" IS NOT NULL
       AND NEW."purgedAt" IS DISTINCT FROM OLD."purgedAt" THEN
      RAISE EXCEPTION 'STORAGE_ORPHAN_CLOSURE_IMMUTABLE: purge closure cannot be cleared or rewritten'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."confirmedAbsentAt" IS NULL AND NEW."confirmedAbsentAt" IS NOT NULL
       AND NEW."confirmedAbsentAt" < COALESCE(OLD."lastAttemptAt", OLD."createdAt") THEN
      RAISE EXCEPTION 'STORAGE_ORPHAN_CLOSURE_INVALID: absence cannot predate the recorded attempt'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."purgedAt" IS NULL AND NEW."purgedAt" IS NOT NULL
       AND (NEW."confirmedAbsentAt" IS NULL OR NEW."purgedAt" < NEW."confirmedAbsentAt") THEN
      RAISE EXCEPTION 'STORAGE_ORPHAN_CLOSURE_INVALID: purge closure requires prior confirmed absence'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."verificationUploadId" IS NULL THEN
    -- Avatar orphan authority predates this migration and remains governed by
    -- its existing namespace/reason checks. Verification objects may not use
    -- this legacy branch after rollout.
    RETURN NEW;
  END IF;
  SELECT u."tenantId", u."userId", u."storageLocationId", u."providerKey", u."objectVersion", u.state
    INTO upload_row
  FROM public.verification_uploads u
  WHERE u.id = NEW."verificationUploadId";
  confirmed_closure := TG_OP = 'UPDATE'
    AND NEW."confirmedAbsentAt" IS NOT NULL
    AND (
      NEW."confirmedAbsentAt" IS DISTINCT FROM OLD."confirmedAbsentAt"
      OR NEW."purgedAt" IS DISTINCT FROM OLD."purgedAt"
    );
  IF NOT FOUND
     OR upload_row."tenantId" <> NEW."tenantId"
     OR upload_row."userId" <> NEW."userId"
     OR upload_row."storageLocationId" <> NEW."storageLocationId"
     OR upload_row."providerKey" <> NEW.key
     OR upload_row."objectVersion" IS NULL
     OR NEW."objectIdentity" <> (
       'v1:'
       || length(upload_row."storageLocationId")::text || ':' || upload_row."storageLocationId" || ':'
       || length(upload_row."providerKey")::text || ':' || upload_row."providerKey" || ':'
       || length(upload_row."objectVersion")::text || ':' || upload_row."objectVersion"
     )
     OR NOT (
       upload_row.state = 'PURGE_PENDING'
       OR (upload_row.state = 'PURGED' AND confirmed_closure AND NEW."purgedAt" IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'STORAGE_ORPHAN_AUTHORITY_INVALID: retry row does not match one purge-pending upload claim'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION storage_orphan_verification_authority_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS storage_orphan_verification_authority_guard ON "storage_orphans";
CREATE TRIGGER storage_orphan_verification_authority_guard
BEFORE INSERT OR UPDATE OF "verificationUploadId", "objectIdentity", "storageLocationId", key, "userId", "tenantId", "quarantinedAt", "quarantineReason", "confirmedAbsentAt", "purgedAt"
ON "storage_orphans" FOR EACH ROW EXECUTE FUNCTION storage_orphan_verification_authority_guard();

-- Tenant wall and lineage: the authenticated uploader's User row is the
-- parent truth; a caller cannot stamp another operator's tenant.
ALTER TABLE "verification_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification_documents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "verification_documents";
CREATE POLICY "tenant_isolation" ON "verification_documents"
  USING (("tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
  WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

CREATE OR REPLACE FUNCTION verification_documents_tenant_matches_user() RETURNS trigger AS $$
DECLARE parent_tenant TEXT;
BEGIN
  SELECT "tenantId" FROM public.users WHERE id = NEW."userId" INTO parent_tenant;
  IF parent_tenant IS NULL THEN
    RAISE EXCEPTION 'verification_documents row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
      NEW.id, NEW."userId" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
    NEW."tenantId" := parent_tenant;
  ELSIF parent_tenant <> NEW."tenantId" THEN
    RAISE EXCEPTION 'verification_documents row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
      NEW.id, NEW."tenantId", NEW."userId", parent_tenant USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION verification_documents_tenant_matches_user() FROM PUBLIC;
DROP TRIGGER IF EXISTS verification_documents_tenant_matches_user ON "verification_documents";
CREATE TRIGGER verification_documents_tenant_matches_user
BEFORE INSERT OR UPDATE OF "tenantId", "userId" ON "verification_documents"
FOR EACH ROW EXECUTE FUNCTION verification_documents_tenant_matches_user();

ALTER TABLE "verification_uploads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification_uploads" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "verification_uploads";
CREATE POLICY "tenant_isolation" ON "verification_uploads"
  USING (("tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
  WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

CREATE OR REPLACE FUNCTION verification_uploads_tenant_matches_user() RETURNS trigger AS $$
DECLARE parent_tenant TEXT;
BEGIN
  SELECT "tenantId" FROM public.users WHERE id = NEW."userId" INTO parent_tenant;
  IF parent_tenant IS NULL THEN
    RAISE EXCEPTION 'verification_uploads row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
      NEW.id, NEW."userId" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
    NEW."tenantId" := parent_tenant;
  ELSIF parent_tenant <> NEW."tenantId" THEN
    RAISE EXCEPTION 'verification_uploads row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
      NEW.id, NEW."tenantId", NEW."userId", parent_tenant USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION verification_uploads_tenant_matches_user() FROM PUBLIC;
DROP TRIGGER IF EXISTS verification_uploads_tenant_matches_user ON "verification_uploads";
CREATE TRIGGER verification_uploads_tenant_matches_user
BEFORE INSERT OR UPDATE OF "tenantId", "userId" ON "verification_uploads"
FOR EACH ROW EXECUTE FUNCTION verification_uploads_tenant_matches_user();

ALTER TABLE "storage_orphans" FORCE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
ALTER TABLE "document_record" FORCE ROW LEVEL SECURITY;
ALTER TABLE "vendors" FORCE ROW LEVEL SECURITY;

COMMIT;
