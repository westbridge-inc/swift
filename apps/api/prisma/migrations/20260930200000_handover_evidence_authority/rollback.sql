BEGIN;
LOCK TABLE handover_photo_proofs, cash_handover_evidence, reimbursement_claims IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM handover_photo_proofs) OR EXISTS (SELECT 1 FROM cash_handover_evidence)
  OR EXISTS (SELECT 1 FROM reimbursement_claims WHERE "handoverEvidenceId" IS NOT NULL)
 THEN RAISE EXCEPTION 'SAFE_B_POPULATED_ROLLBACK_REFUSED'; END IF;
END $$;
DROP TRIGGER safeb_claim_binding ON reimbursement_claims;
ALTER TABLE reimbursement_claims DROP COLUMN "handoverEvidenceId";
DROP TABLE cash_handover_evidence;
DROP TABLE handover_photo_proofs;
DROP FUNCTION safeb_claim_evidence_binding();
DROP FUNCTION safeb_immutable_handover();
DROP FUNCTION safeb_handover_lineage();
COMMIT;
