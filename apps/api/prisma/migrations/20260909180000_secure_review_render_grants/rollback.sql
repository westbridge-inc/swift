-- Structural rollback only. Access-audit rows live in sensitive_read_logs and
-- remain intact. Disable document review before executing this rollback.
BEGIN;

DROP TABLE IF EXISTS "review_render_grants";
DROP INDEX IF EXISTS "review_case_one_open_per_submission_idx";
ALTER TABLE "review_case"
  DROP CONSTRAINT IF EXISTS "review_case_second_review_provenance_check",
  DROP CONSTRAINT IF EXISTS "review_case_assignment_epoch_check",
  DROP COLUMN IF EXISTS "secondReviewEvidenceRef",
  DROP COLUMN IF EXISTS "secondReviewOrigin",
  DROP COLUMN IF EXISTS "assignmentEpoch";
DROP TYPE IF EXISTS "SecondReviewOrigin";

COMMIT;
