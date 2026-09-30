-- Empty-fence rollback only. Once authority/retirement exists, retain this schema
-- and stop destructive execution; use a forward correction. Never discard claims.
-- Run only after excluding ALL destructive workers, then acknowledge in this
-- session: SET app.document_purge_workers_stopped = 'true';
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF current_setting('app.document_purge_workers_stopped', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'rollback requires explicit stopped-worker acknowledgement';
  END IF;
END $$;
LOCK TABLE users, verification_documents, encrypted_objects, storage_orphans,
  document_purge_claim, document_purge_event, extraction_run, extracted_field,
  doc_legal_hold, deletion_receipt IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM document_purge_claim)
    OR EXISTS (SELECT 1 FROM document_purge_event)
    OR EXISTS (SELECT 1 FROM encrypted_objects WHERE "retiredClaimId" IS NOT NULL OR "uploadState" = 'PENDING')
    OR EXISTS (SELECT 1 FROM verification_documents WHERE "activePurgeClaimId" IS NOT NULL OR "imageCompletionClaimId" IS NOT NULL OR "fieldsPurgedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM deletion_receipt WHERE "purgeClaimId" IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback refused: durable authority, events, reservations or completion provenance exist';
  END IF;
END $$;
DROP TRIGGER document_purge_orphan_guard ON storage_orphans;
DROP TRIGGER document_purge_user_guard ON users;
DROP TRIGGER document_purge_receipt_guard ON deletion_receipt;
DROP TRIGGER document_legal_hold_guard ON doc_legal_hold;
DROP TRIGGER document_extraction_guard ON extracted_field;
DROP TRIGGER document_extraction_guard ON extraction_run;
DROP TRIGGER zz_document_hold_purge_guard ON verification_documents;
DROP TRIGGER document_source_guard ON encrypted_objects;
DROP TRIGGER document_purge_event_guard ON document_purge_event;
DROP TRIGGER document_purge_claim_guard ON document_purge_claim;
DROP FUNCTION document_purge_orphan_guard();
DROP FUNCTION document_purge_user_guard();
DROP FUNCTION document_purge_receipt_guard();
DROP FUNCTION document_legal_hold_guard();
DROP FUNCTION document_extraction_guard();
DROP FUNCTION document_hold_purge_guard();
DROP FUNCTION document_source_guard();
DROP FUNCTION document_source_key_guard(text,text);
DROP FUNCTION document_purge_event_guard();
DROP FUNCTION document_purge_claim_guard();
ALTER TABLE deletion_receipt DROP COLUMN "purgeClaimId", DROP COLUMN scope;
ALTER TABLE verification_documents DROP CONSTRAINT verification_documents_active_claim_fk,
  DROP CONSTRAINT verification_documents_image_claim_fk;
ALTER TABLE encrypted_objects DROP CONSTRAINT encrypted_objects_retirement_fk;
DROP TABLE document_purge_event;
DROP TABLE document_purge_claim;
ALTER TABLE verification_documents DROP COLUMN "activePurgeClaimId", DROP COLUMN "imageCompletionClaimId",
  DROP COLUMN "fieldsPurgedAt", DROP COLUMN "imageSourceKind";
ALTER TABLE encrypted_objects DROP COLUMN "sourceId", DROP COLUMN "retiredClaimId",
  DROP COLUMN "storageNamespace", DROP COLUMN "uploadState";
COMMIT;
