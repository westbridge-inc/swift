-- [NO-AI · owner rule 2026-09-07] The document state machine, human review only.
--
-- FORWARD: re-seed doc_state_transition from DOC_TRANSITIONS (doc-state.ts) and re-install the
--          trigger from the same generator (docStateMachineDdl — mirrored verbatim below, as the
--          suite asserts). Three automatic-decision rows leave the table:
--            CAPTURED  -> REJECTED       (T3 preprocess_fail: an unreadable capture now goes to a person, T6)
--            VALIDATED -> AUTO_APPROVED  (T8 route: no automatic approval)
--            VALIDATED -> REJECTED       (X-AUTO-REJECT, CONFLICT-DOC-8: no automatic rejection)
--          Every remaining pair INTO APPROVED or REJECTED starts at IN_REVIEW (a claimed case).
--          No column, table, enum value or verification_documents row changes; AUTO_APPROVED stays
--          in the enum with its OUT-transitions for rows that reached it before this rule. The helper
--          functions and the trigger body are byte-identical to 20260906090000_doc_state_machine.
--
-- ROLLBACK (three configuration rows; no document data is touched by either direction):
--   INSERT INTO doc_state_transition ("fromState", "toState", event, spec) VALUES
--     ('CAPTURED', 'REJECTED', 'preprocess_fail', 'T3'),
--     ('VALIDATED', 'AUTO_APPROVED', 'route', 'T8'),
--     ('VALIDATED', 'REJECTED', 'auto_reject', 'X-AUTO-REJECT (CONFLICT-DOC-8)')
--   ON CONFLICT ("fromState", "toState") DO UPDATE SET event = EXCLUDED.event, spec = EXCLUDED.spec;
--   (nothing else to undo: functions and trigger are unchanged by this migration)
--
-- BACKUP CHECKPOINT: pg_dump --table=doc_state_transition immediately before `migrate deploy`
--                    (deploy/backup.sh takes the full dump); the rollback above is tested in the
--                    lane report against a replayed database.

CREATE OR REPLACE FUNCTION doc_state_legacy_status(s "DocState") RETURNS "VerificationDocumentStatus"
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE s
    WHEN 'CAPTURED' THEN 'PENDING'::"VerificationDocumentStatus"
    WHEN 'PREPROCESSED' THEN 'PENDING'::"VerificationDocumentStatus"
    WHEN 'EXTRACTING' THEN 'PENDING'::"VerificationDocumentStatus"
    WHEN 'EXTRACTED' THEN 'PENDING'::"VerificationDocumentStatus"
    WHEN 'VALIDATED' THEN 'PENDING'::"VerificationDocumentStatus"
    WHEN 'AUTO_APPROVED' THEN 'APPROVED'::"VerificationDocumentStatus"
    WHEN 'REVIEW_QUEUED' THEN 'PENDING'::"VerificationDocumentStatus"
    WHEN 'IN_REVIEW' THEN 'PENDING'::"VerificationDocumentStatus"
    WHEN 'INFO_REQUESTED' THEN 'PENDING'::"VerificationDocumentStatus"
    WHEN 'APPROVED' THEN 'APPROVED'::"VerificationDocumentStatus"
    WHEN 'REJECTED' THEN 'REJECTED'::"VerificationDocumentStatus"
    WHEN 'COMMITTED' THEN 'APPROVED'::"VerificationDocumentStatus"
    WHEN 'PURGED' THEN NULL
    WHEN 'EXPIRED' THEN 'EXPIRED'::"VerificationDocumentStatus"
    WHEN 'SUPERSEDED' THEN NULL
    WHEN 'REVOKED' THEN 'REJECTED'::"VerificationDocumentStatus"
    WHEN 'LEGAL_HOLD' THEN NULL
  END
$$;

CREATE OR REPLACE FUNCTION doc_state_from_legacy(st "VerificationDocumentStatus", purged timestamptz) RETURNS "DocState"
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN purged IS NOT NULL THEN 'PURGED'::"DocState"
    WHEN st = 'APPROVED' THEN 'COMMITTED'::"DocState"
    WHEN st = 'REJECTED' THEN 'REJECTED'::"DocState"
    WHEN st = 'EXPIRED' THEN 'EXPIRED'::"DocState"
    ELSE 'REVIEW_QUEUED'::"DocState"
  END
$$;

INSERT INTO doc_state_transition ("fromState", "toState", event, spec) VALUES
  ('CAPTURED', 'PREPROCESSED', 'preprocess', 'T2'),
  ('PREPROCESSED', 'EXTRACTING', 'extract', 'T4'),
  ('EXTRACTING', 'EXTRACTED', 'extraction_ok', 'T5'),
  ('EXTRACTING', 'REVIEW_QUEUED', 'extraction_fail', 'T6'),
  ('EXTRACTED', 'VALIDATED', 'validate', 'T7'),
  ('VALIDATED', 'REVIEW_QUEUED', 'route', 'T9'),
  ('AUTO_APPROVED', 'REVIEW_QUEUED', 'qa_sample', 'T10'),
  ('REVIEW_QUEUED', 'IN_REVIEW', 'claim', 'T11'),
  ('IN_REVIEW', 'APPROVED', 'decide', 'T12'),
  ('IN_REVIEW', 'REJECTED', 'decide', 'T13'),
  ('IN_REVIEW', 'INFO_REQUESTED', 'decide', 'T14'),
  ('IN_REVIEW', 'REVIEW_QUEUED', 'decide', 'T15 escalate · X-RELEASE'),
  ('INFO_REQUESTED', 'SUPERSEDED', 'resubmit', 'T16'),
  ('APPROVED', 'COMMITTED', 'commit', 'T17'),
  ('AUTO_APPROVED', 'COMMITTED', 'commit', 'T17'),
  ('COMMITTED', 'EXPIRED', 'expire', 'T20'),
  ('COMMITTED', 'REVOKED', 'revoke', 'T23'),
  ('COMMITTED', 'SUPERSEDED', 'supersede', '§22 renewal'),
  ('REVIEW_QUEUED', 'EXPIRED', 'expire', 'X-EXPIRE-PENDING'),
  ('IN_REVIEW', 'EXPIRED', 'expire', 'X-EXPIRE-PENDING'),
  ('INFO_REQUESTED', 'EXPIRED', 'expire', 'X-EXPIRE-PENDING'),
  ('CAPTURED', 'PURGED', 'purge', 'X-PURGE-ANY'),
  ('PREPROCESSED', 'PURGED', 'purge', 'X-PURGE-ANY'),
  ('EXTRACTING', 'PURGED', 'purge', 'X-PURGE-ANY'),
  ('EXTRACTED', 'PURGED', 'purge', 'X-PURGE-ANY'),
  ('VALIDATED', 'PURGED', 'purge', 'X-PURGE-ANY'),
  ('AUTO_APPROVED', 'PURGED', 'purge', 'X-PURGE-ANY'),
  ('REVIEW_QUEUED', 'PURGED', 'purge', 'X-PURGE-ANY'),
  ('IN_REVIEW', 'PURGED', 'purge', 'X-PURGE-ANY'),
  ('INFO_REQUESTED', 'PURGED', 'purge', 'X-PURGE-ANY'),
  ('APPROVED', 'PURGED', 'purge', 'X-PURGE-ANY'),
  ('REJECTED', 'PURGED', 'purge', 'T24'),
  ('COMMITTED', 'PURGED', 'purge', 'T18'),
  ('EXPIRED', 'PURGED', 'purge', 'X-PURGE-ANY'),
  ('SUPERSEDED', 'PURGED', 'purge', 'X-PURGE-ANY'),
  ('REVOKED', 'PURGED', 'purge', 'X-PURGE-ANY')
ON CONFLICT ("fromState", "toState") DO UPDATE SET event = EXCLUDED.event, spec = EXCLUDED.spec;

DELETE FROM doc_state_transition WHERE ("fromState", "toState") NOT IN (('CAPTURED', 'PREPROCESSED'), ('PREPROCESSED', 'EXTRACTING'), ('EXTRACTING', 'EXTRACTED'), ('EXTRACTING', 'REVIEW_QUEUED'), ('EXTRACTED', 'VALIDATED'), ('VALIDATED', 'REVIEW_QUEUED'), ('AUTO_APPROVED', 'REVIEW_QUEUED'), ('REVIEW_QUEUED', 'IN_REVIEW'), ('IN_REVIEW', 'APPROVED'), ('IN_REVIEW', 'REJECTED'), ('IN_REVIEW', 'INFO_REQUESTED'), ('IN_REVIEW', 'REVIEW_QUEUED'), ('INFO_REQUESTED', 'SUPERSEDED'), ('APPROVED', 'COMMITTED'), ('AUTO_APPROVED', 'COMMITTED'), ('COMMITTED', 'EXPIRED'), ('COMMITTED', 'REVOKED'), ('COMMITTED', 'SUPERSEDED'), ('REVIEW_QUEUED', 'EXPIRED'), ('IN_REVIEW', 'EXPIRED'), ('INFO_REQUESTED', 'EXPIRED'), ('CAPTURED', 'PURGED'), ('PREPROCESSED', 'PURGED'), ('EXTRACTING', 'PURGED'), ('EXTRACTED', 'PURGED'), ('VALIDATED', 'PURGED'), ('AUTO_APPROVED', 'PURGED'), ('REVIEW_QUEUED', 'PURGED'), ('IN_REVIEW', 'PURGED'), ('INFO_REQUESTED', 'PURGED'), ('APPROVED', 'PURGED'), ('REJECTED', 'PURGED'), ('COMMITTED', 'PURGED'), ('EXPIRED', 'PURGED'), ('SUPERSEDED', 'PURGED'), ('REVOKED', 'PURGED'));

CREATE OR REPLACE FUNCTION verification_documents_doc_state() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  via_approved boolean := false;
BEGIN
  IF NEW.state = 'LEGAL_HOLD' THEN
    RAISE EXCEPTION 'DOC_STATE_ILLEGAL: LEGAL_HOLD is an overlay (legalHoldId), never a stored state';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS NULL THEN
      NEW.state := doc_state_from_legacy(NEW.status, NEW."purgedAt");
    ELSE
      NEW.status := COALESCE(doc_state_legacy_status(NEW.state), NEW.status);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state IS NULL THEN
    NEW.state := OLD.state;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    -- state-driven write: the projection follows the state
    NULL;
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR (NEW."purgedAt" IS NOT NULL AND OLD."purgedAt" IS NULL) THEN
    -- legacy-driven write: derive the state, then judge it like any other
    NEW.state := doc_state_from_legacy(NEW.status, NEW."purgedAt");
    IF NEW.state = 'COMMITTED' AND OLD.state NOT IN ('APPROVED', 'AUTO_APPROVED') THEN
      -- a legacy approval passes through APPROVED on its way to COMMITTED (T12 then T17)
      IF NOT EXISTS (SELECT 1 FROM doc_state_transition t WHERE t."fromState" = OLD.state AND t."toState" = 'APPROVED') THEN
        RAISE EXCEPTION 'DOC_STATE_ILLEGAL: % -> APPROVED is not a transition', OLD.state;
      END IF;
      via_approved := true;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF NOT via_approved AND NOT EXISTS (
    SELECT 1 FROM doc_state_transition t WHERE t."fromState" = OLD.state AND t."toState" = NEW.state
  ) THEN
    RAISE EXCEPTION 'DOC_STATE_ILLEGAL: % -> % is not a transition', OLD.state, NEW.state;
  END IF;

  IF NEW.state = 'PURGED' AND NEW."legalHoldId" IS NOT NULL THEN
    RAISE EXCEPTION 'DOC_STATE_ILLEGAL: PURGED under a legal hold';
  END IF;

  IF NEW.state = 'AUTO_APPROVED' AND EXISTS (
    SELECT 1 FROM validation_result v WHERE v."submissionId" = NEW.id AND v."isBlocking" AND v.status = 'FAIL'
  ) THEN
    RAISE EXCEPTION 'DOC_STATE_ILLEGAL: AUTO_APPROVED with a blocking FAIL';
  END IF;

  IF NEW.state = 'COMMITTED' AND NOT (
    EXISTS (
      SELECT 1 FROM review_decision d JOIN review_case c ON c.id = d."caseId"
      WHERE c."submissionId" = NEW.id AND d.outcome = 'APPROVE'
    )
    OR (OLD.state = 'AUTO_APPROVED' AND EXISTS (SELECT 1 FROM extraction_run r WHERE r."submissionId" = NEW.id))
  ) THEN
    RAISE EXCEPTION 'DOC_STATE_ILLEGAL: COMMITTED without provenance (an APPROVE decision or the AUTO_APPROVED ledger)';
  END IF;

  NEW.status := COALESCE(doc_state_legacy_status(NEW.state), NEW.status);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS verification_documents_doc_state ON verification_documents;

CREATE TRIGGER verification_documents_doc_state
BEFORE INSERT OR UPDATE ON verification_documents
FOR EACH ROW EXECUTE FUNCTION verification_documents_doc_state();
