BEGIN;
LOCK TABLE mmg_payer_evidence, identity_review_cases, identity_clusters, identity_keys IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM mmg_payer_evidence) OR EXISTS (SELECT 1 FROM identity_review_cases)
  OR EXISTS (SELECT 1 FROM identity_clusters WHERE "authorityReviewRequired")
  OR EXISTS (SELECT 1 FROM identity_keys WHERE "mmgEvidenceId" IS NOT NULL)
 THEN RAISE EXCEPTION 'SAFE_B_POPULATED_ROLLBACK_REFUSED'; END IF;
END $$;
DROP TRIGGER IF EXISTS safeb_trial_authority ON trial_grants;
DROP TRIGGER IF EXISTS safeb_exception_authority ON exception_grants;
DROP TRIGGER IF EXISTS safeb_cluster_authority_lock ON identity_clusters;
DROP TRIGGER IF EXISTS safeb_cluster_review_monotonic ON identity_clusters;
DROP TRIGGER IF EXISTS safeb_no_promoted_payer_key ON identity_keys;
DROP TRIGGER safeb_no_unproven_payer_key ON identity_keys;
ALTER TABLE identity_keys DROP COLUMN "mmgEvidenceId";
ALTER TABLE identity_clusters DROP COLUMN "authorityReviewRequired";
DROP TABLE identity_review_cases;
DROP TABLE mmg_payer_evidence;
DROP FUNCTION IF EXISTS safeb_new_identity_benefit();
DROP FUNCTION IF EXISTS safeb_cluster_review_monotonic();
DROP FUNCTION IF EXISTS safeb_identity_authority_lock();
DROP FUNCTION IF EXISTS safeb_review_case_lineage();
DROP FUNCTION IF EXISTS safeb_review_case_immutable();
DROP FUNCTION safeb_no_unproven_payer_key();
DROP FUNCTION safeb_payer_immutable();
DROP FUNCTION safeb_payer_lineage();
COMMIT;
