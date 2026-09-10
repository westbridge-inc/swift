-- A provider or OCR engine may supply evidence, but it may not make the
-- significant adverse decision that rejects an identity, licence, or
-- criminal-record document. The only remaining path into REJECTED is a human
-- review decision (IN_REVIEW -> REJECTED), plus CAPTURED -> REJECTED for a
-- technical intake/preprocessing failure before the document is assessed.
BEGIN;

DELETE FROM doc_state_transition
WHERE "fromState" = 'VALIDATED'::"DocState"
  AND "toState" = 'REJECTED'::"DocState";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM doc_state_transition
    WHERE "fromState" = 'VALIDATED'::"DocState"
      AND "toState" = 'REJECTED'::"DocState"
  ) THEN
    RAISE EXCEPTION 'AUTOMATED_ADVERSE_TRANSITION_STILL_ENABLED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM doc_state_transition
    WHERE "fromState" = 'IN_REVIEW'::"DocState"
      AND "toState" = 'REJECTED'::"DocState"
      AND event = 'decide'
  ) THEN
    RAISE EXCEPTION 'HUMAN_REJECTION_TRANSITION_MISSING';
  END IF;
END $$;

COMMIT;
