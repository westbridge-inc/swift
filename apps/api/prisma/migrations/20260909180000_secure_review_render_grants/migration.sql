BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TYPE "SecondReviewOrigin" AS ENUM ('HUMAN_ESCALATION', 'MACHINE_COLLISION');

ALTER TABLE "review_case"
  ADD COLUMN "assignmentEpoch" UUID,
  ADD COLUMN "secondReviewOrigin" "SecondReviewOrigin",
  ADD COLUMN "secondReviewEvidenceRef" TEXT;

-- Assigned legacy cases receive a non-ABA generation. Inconsistent partial
-- assignments and unexplained second-review cases fail before constraints are
-- installed; guessing provenance would manufacture audit evidence.
UPDATE "review_case"
SET "assignmentEpoch" = gen_random_uuid()
WHERE "assignedTo" IS NOT NULL AND "assignedAt" IS NOT NULL;

WITH latest_escalation AS (
  SELECT DISTINCT ON (rd."caseId") rd."caseId", rd."id"
  FROM "review_decision" rd
  WHERE rd."outcome" = 'ESCALATE'
  ORDER BY rd."caseId", rd."decidedAt" DESC, rd."id" DESC
)
UPDATE "review_case" c
SET "secondReviewOrigin" = 'HUMAN_ESCALATION',
    "secondReviewEvidenceRef" = d."id"::text
FROM latest_escalation d
WHERE c."queue" = 'SECOND_REVIEW'
  AND d."caseId" = c."id";

-- Do not infer MACHINE_COLLISION provenance from a validator row alone. The
-- runtime law also requires exactly one consumed upload and matching subject +
-- cross-account HMAC identity keys. PostgreSQL cannot recompute that HMAC
-- without importing an application secret into migration history. Any legacy
-- machine case therefore fails the census below for explicit, evidenced
-- application-layer reconciliation; new cases persist all authority at birth.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "review_case"
    WHERE (("assignedTo" IS NULL)::int + ("assignedAt" IS NULL)::int + ("assignmentEpoch" IS NULL)::int) NOT IN (0, 3)
  ) THEN
    RAISE EXCEPTION 'REVIEW_CASE_ASSIGNMENT_PREFLIGHT_FAILED: partial assignment requires reconciliation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "review_case"
    WHERE "queue" = 'SECOND_REVIEW'
      AND ("secondReviewOrigin" IS NULL OR "secondReviewEvidenceRef" IS NULL)
  ) THEN
    RAISE EXCEPTION 'SECOND_REVIEW_PREFLIGHT_FAILED: exact escalation or application-validated collision provenance requires reconciliation';
  END IF;
END $$;

ALTER TABLE "review_case"
  ADD CONSTRAINT "review_case_assignment_epoch_check" CHECK (
    ("assignedTo" IS NULL AND "assignedAt" IS NULL AND "assignmentEpoch" IS NULL)
    OR ("assignedTo" IS NOT NULL AND "assignedAt" IS NOT NULL AND "assignmentEpoch" IS NOT NULL)
  ),
  ADD CONSTRAINT "review_case_second_review_provenance_check" CHECK (
    ("queue" = 'SECOND_REVIEW' AND "secondReviewOrigin" IS NOT NULL AND "secondReviewEvidenceRef" IS NOT NULL)
    OR ("queue" <> 'SECOND_REVIEW' AND "secondReviewOrigin" IS NULL AND "secondReviewEvidenceRef" IS NULL)
  );

-- One active case is the authority boundary for a human document review.
-- Refuse rather than silently choosing or closing a duplicate: reconciliation
-- needs its own evidenced operator decision.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "review_case"
    WHERE "closedAt" IS NULL
    GROUP BY "submissionId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'REVIEW_CASE_PREFLIGHT_FAILED: duplicate open cases require reconciliation';
  END IF;
END $$;

CREATE UNIQUE INDEX "review_case_one_open_per_submission_idx"
  ON "review_case"("submissionId")
  WHERE "closedAt" IS NULL;

-- A grant is a short-lived workflow capability, not the access audit itself.
-- Its random bearer value is never stored; tokenHash is the lookup authority.
CREATE TABLE "review_render_grants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tokenHash" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "caseId" UUID NOT NULL,
  "reviewerId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "assignmentAt" TIMESTAMP(3) NOT NULL,
  "assignmentEpoch" UUID NOT NULL,
  "storageLocationId" TEXT NOT NULL,
  "objectKeyHash" TEXT NOT NULL,
  "objectVersion" TEXT NOT NULL,
  "objectEncrypted" BOOLEAN NOT NULL,
  "objectSha256" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "reservedAt" TIMESTAMP(3),
  "fetchedAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "review_render_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_render_grants_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "review_render_grants_object_key_hash_check" CHECK ("objectKeyHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "review_render_grants_object_sha256_check" CHECK ("objectSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "review_render_grants_generation_check" CHECK (length("storageLocationId") > 0 AND length("objectVersion") > 0),
  CONSTRAINT "review_render_grants_time_order_check" CHECK (
    "expiresAt" > "createdAt"
    AND ("fetchedAt" IS NULL OR "reservedAt" IS NOT NULL)
    AND ("acknowledgedAt" IS NULL OR "fetchedAt" IS NOT NULL)
    AND ("consumedAt" IS NULL OR ("acknowledgedAt" IS NOT NULL AND "revokedAt" IS NULL))
    AND ("revokedAt" IS NULL OR "consumedAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "review_render_grants_tokenHash_key"
  ON "review_render_grants"("tokenHash");
CREATE INDEX "review_render_grants_tenantId_reviewerId_expiresAt_idx"
  ON "review_render_grants"("tenantId", "reviewerId", "expiresAt");
CREATE INDEX "review_render_grants_documentId_caseId_idx"
  ON "review_render_grants"("documentId", "caseId");
CREATE INDEX "review_render_grants_caseId_assignmentEpoch_idx"
  ON "review_render_grants"("caseId", "assignmentEpoch");
CREATE INDEX "review_render_grants_sessionId_idx"
  ON "review_render_grants"("sessionId");

ALTER TABLE "review_render_grants"
  ADD CONSTRAINT "review_render_grants_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_render_grants_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "verification_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_render_grants_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "review_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_render_grants_reviewerId_fkey"
    FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_render_grants_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_render_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_render_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "review_render_grants"
  USING (("tenantId" = current_setting('app.current_tenant', true))
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'))
  WITH CHECK (("tenantId" = current_setting('app.current_tenant', true))
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'));

COMMIT;
