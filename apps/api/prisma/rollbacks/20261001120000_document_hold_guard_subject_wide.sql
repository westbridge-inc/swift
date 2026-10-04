-- Rollback of 20261001120000_document_hold_guard_subject_wide: restores the two guard functions exactly as
-- 20260930190000_document_purge_hold_fence created them and removes this migration's own history row,
-- in one transaction, so a later `prisma migrate deploy` re-applies it. Functions only: no data is touched.
-- Run it BEFORE that fence's own rollback; the fence rollback also removes this history row, since dropping
-- the fence's functions undoes this migration as well.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF to_regprocedure('document_hold_purge_guard()') IS NULL OR to_regprocedure('document_extraction_guard()') IS NULL THEN
    RAISE EXCEPTION 'rollback refused: the document purge fence is not installed';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION document_hold_purge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c document_purge_claim; owner_id text;
BEGIN
  owner_id := CASE WHEN TG_OP = 'INSERT' THEN NEW."userId" ELSE OLD."userId" END;
  PERFORM 1 FROM users WHERE id = owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document owner unavailable'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."activePurgeClaimId" IS NOT NULL OR NEW."imageCompletionClaimId" IS NOT NULL OR NEW."fieldsPurgedAt" IS NOT NULL THEN RAISE EXCEPTION 'new document cannot carry purge authority'; END IF;
    IF NEW."legalHoldId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM doc_legal_hold h JOIN users u ON u.id = h."subjectUserId" AND u."tenantId" = h."tenantId" WHERE h.id = NEW."legalHoldId" AND h."subjectUserId" = owner_id AND h."releasedAt" IS NULL) THEN RAISE EXCEPTION 'new document hold lineage mismatch'; END IF;
    NEW."imageSourceKind" := CASE WHEN NEW."fileUrl" = '' THEN 'BORN_EMPTY' ELSE 'OBJECT' END;
    IF NEW."fileUrl" <> '' THEN PERFORM document_source_key_guard(NEW."fileUrl", owner_id); END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."legalHoldId" IS NOT NULL OR OLD."activePurgeClaimId" IS NOT NULL OR EXISTS (SELECT 1 FROM document_purge_claim WHERE "documentId" = OLD.id) THEN RAISE EXCEPTION 'held or claimed document cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF NEW."imageSourceKind" IS DISTINCT FROM OLD."imageSourceKind" THEN RAISE EXCEPTION 'source origin immutable'; END IF;
  IF OLD."legalHoldId" IS NOT NULL AND NEW."legalHoldId" IS DISTINCT FROM OLD."legalHoldId" AND NOT EXISTS (SELECT 1 FROM doc_legal_hold WHERE id = OLD."legalHoldId" AND "releasedAt" IS NOT NULL) THEN RAISE EXCEPTION 'active hold cannot be unstamped'; END IF;
  IF NEW."legalHoldId" IS NOT NULL AND NEW."legalHoldId" IS DISTINCT FROM OLD."legalHoldId" THEN
    -- Per document: never stamp a document whose own destruction is committed.
    -- (An unattached upload is never a document; whether a whole-person hold may
    -- be reported while one is being destroyed is the hold writer's decision.)
    IF EXISTS (SELECT 1 FROM document_purge_claim WHERE "userId" = owner_id AND state = 'COMMITTED' AND "documentId" = OLD.id) THEN RAISE EXCEPTION 'DOCUMENT_PURGE_COMMITTED'; END IF;
    IF NOT EXISTS (SELECT 1 FROM doc_legal_hold h JOIN users u ON u.id = h."subjectUserId" AND u."tenantId" = h."tenantId" WHERE h.id = NEW."legalHoldId" AND h."subjectUserId" = owner_id AND h."releasedAt" IS NULL) THEN RAISE EXCEPTION 'hold lineage mismatch'; END IF;
  END IF;
  IF OLD."legalHoldId" IS NOT NULL OR EXISTS (SELECT 1 FROM document_purge_claim WHERE "documentId" = OLD.id) THEN
    IF (NEW.id, NEW."userId", NEW."subjectId", NEW.role, NEW."docType", NEW."imageSourceKind") IS DISTINCT FROM (OLD.id, OLD."userId", OLD."subjectId", OLD.role, OLD."docType", OLD."imageSourceKind") THEN RAISE EXCEPTION 'held or claimed identity immutable'; END IF;
  END IF;
  IF NEW."activePurgeClaimId" IS NOT NULL THEN
    SELECT * INTO c FROM document_purge_claim WHERE id = NEW."activePurgeClaimId" AND "documentId" = OLD.id AND "userId" = owner_id AND state = 'COMMITTED';
    IF NOT FOUND OR NEW."legalHoldId" IS NOT NULL THEN RAISE EXCEPTION 'document claim pointer mismatch'; END IF;
  ELSE
    SELECT * INTO c FROM document_purge_claim WHERE id = OLD."activePurgeClaimId" AND "documentId" = OLD.id;
  END IF;
  IF (NEW.state = 'PURGED' AND NEW.state IS DISTINCT FROM OLD.state) OR NEW."fileUrl" IS DISTINCT FROM OLD."fileUrl" OR NEW."purgedAt" IS DISTINCT FROM OLD."purgedAt" OR NEW."imagePurgedAt" IS DISTINCT FROM OLD."imagePurgedAt" OR NEW."fieldsPurgedAt" IS DISTINCT FROM OLD."fieldsPurgedAt" OR NEW."imageCompletionClaimId" IS DISTINCT FROM OLD."imageCompletionClaimId" THEN
    IF OLD."legalHoldId" IS NOT NULL OR c.id IS NULL OR c."claimXid" = txid_current() OR NEW."fileUrl" <> '' THEN RAISE EXCEPTION 'committed document authority required'; END IF;
    IF c.mode = 'IMAGE_ONLY' AND (NEW."purgedAt", NEW."fieldsPurgedAt") IS DISTINCT FROM (OLD."purgedAt", OLD."fieldsPurgedAt") THEN RAISE EXCEPTION 'image authority cannot erase fields'; END IF;
    IF NEW."fieldsPurgedAt" IS DISTINCT FROM OLD."fieldsPurgedAt" AND c.mode <> 'FULL_ERASURE' THEN RAISE EXCEPTION 'field erasure authority required'; END IF;
  END IF;
  IF OLD."activePurgeClaimId" IS NOT NULL AND NEW."activePurgeClaimId" IS DISTINCT FROM OLD."activePurgeClaimId" AND (NEW."activePurgeClaimId" IS NOT NULL OR c.state <> 'COMPLETE') THEN RAISE EXCEPTION 'active authority cannot be revoked'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION document_extraction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d verification_documents; c document_purge_claim; sid text; old_value bytea; new_value bytea;
BEGIN
  sid := CASE WHEN TG_OP = 'INSERT' THEN NEW."submissionId" ELSE OLD."submissionId" END;
  SELECT * INTO d FROM verification_documents WHERE id = sid;
  PERFORM 1 FROM users WHERE id = d."userId" FOR UPDATE;
  SELECT * INTO d FROM verification_documents WHERE id = sid FOR UPDATE;
  SELECT * INTO c FROM document_purge_claim WHERE "documentId" = sid AND mode = 'FULL_ERASURE' LIMIT 1;
  IF TG_OP <> 'DELETE' AND TG_TABLE_NAME = 'extracted_field' THEN
    IF NOT EXISTS (SELECT 1 FROM extraction_run WHERE id = (to_jsonb(NEW)->>'runId')::uuid AND "submissionId" = NEW."submissionId" AND "tenantId" = NEW."tenantId") THEN RAISE EXCEPTION 'extracted field run lineage mismatch'; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF c.id IS NOT NULL THEN RAISE EXCEPTION 'erased extraction scope closed'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF d."legalHoldId" IS NOT NULL OR EXISTS (SELECT 1 FROM document_purge_claim WHERE "documentId" = sid) THEN RAISE EXCEPTION 'held or claimed extraction cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  old_value := CASE WHEN TG_TABLE_NAME = 'extraction_run' THEN decode(substr(to_jsonb(OLD)->>'wrappedDek',3),'hex') ELSE decode(substr(to_jsonb(OLD)->>'valueCt',3),'hex') END;
  new_value := CASE WHEN TG_TABLE_NAME = 'extraction_run' THEN decode(substr(to_jsonb(NEW)->>'wrappedDek',3),'hex') ELSE decode(substr(to_jsonb(NEW)->>'valueCt',3),'hex') END;
  IF (NEW.id, NEW."submissionId", NEW."tenantId") IS DISTINCT FROM (OLD.id, OLD."submissionId", OLD."tenantId") AND (c.id IS NOT NULL OR d."legalHoldId" IS NOT NULL) THEN RAISE EXCEPTION 'extraction identity immutable'; END IF;
  IF (c.id IS NOT NULL OR d."legalHoldId" IS NOT NULL) AND (to_jsonb(NEW) - 'wrappedDek' - 'valueCt') IS DISTINCT FROM (to_jsonb(OLD) - 'wrappedDek' - 'valueCt') THEN RAISE EXCEPTION 'claimed extraction identity immutable'; END IF;
  IF new_value IS DISTINCT FROM old_value THEN
    IF d."legalHoldId" IS NOT NULL THEN RAISE EXCEPTION 'held extraction immutable'; END IF;
    IF c.id IS NOT NULL OR new_value IS NULL THEN
      IF c.id IS NULL OR c."claimXid" = txid_current() OR c.state <> 'COMMITTED' OR new_value IS NOT NULL OR
        (TG_TABLE_NAME = 'extraction_run' AND NOT OLD.id = ANY(c."runIds")) OR
        (TG_TABLE_NAME = 'extracted_field' AND NOT OLD.id = ANY(c."fieldIds")) THEN RAISE EXCEPTION 'committed field scope required'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE migration_name = '20261001120000_document_hold_guard_subject_wide';
  END IF;
END $$;
COMMIT;
