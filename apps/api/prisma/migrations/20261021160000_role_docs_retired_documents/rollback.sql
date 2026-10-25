-- Rollback for 20261021160000_role_docs_retired_documents (REVIEW-G #2001 S4).
-- What can be undone: a clock on a copy the reaper has NOT deleted yet. Such a copy goes back to "kept while the
-- person is active" (no clock), the state almost every one of them had before; a row that held an earlier clock of
-- its own is not distinguishable and gets none (the next leave / ban / rejection sets one again).
-- What cannot be undone: a copy already purged (bytes shredded, deletion receipt written) and the deleted
-- GEI_LICENCE qualifications (typed numbers no review ever verified). Restore the code first: the old lists must
-- ask for these documents again, or the next sweep has nothing to keep them for.
UPDATE verification_documents AS d SET "retentionExpiresAt" = NULL
WHERE d."purgedAt" IS NULL AND d."legalHoldId" IS NULL
  -- never a clock another rule set: a rejected copy (30/90 days after the decision) or a person who left
  AND d.status <> 'REJECTED'
  AND EXISTS (SELECT 1 FROM users AS u WHERE u.id = d."userId" AND u.status = 'ACTIVE' AND u.phone NOT LIKE 'deleted:%')
  AND (
    (d."docType" IN ('police_clearance', 'national_id') AND d.role IN ('MOVER', 'RIDER', 'DRIVER'))
    OR d."docType" IN ('liquor_licence', 'pharmacy_authorisation', 'nis_employer_reg')
  );
