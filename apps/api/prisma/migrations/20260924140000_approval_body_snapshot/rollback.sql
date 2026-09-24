-- ROLLBACK for 20260924140000_approval_body_snapshot.
--
-- Dropping the column discards the stored request body for approvals raised
-- after the migration. Those rows can no longer be APPLIED (there is no body
-- to replay), which is the safe direction: they stay APPROVED and the
-- requester must ask again after the column returns. Forward repair (re-applying
-- the migration) is preferred; re-application restores storage for NEW rows
-- only — the snapshot of rows written while the column was absent is gone.
SET lock_timeout = '10s';
ALTER TABLE "privileged_approvals" DROP COLUMN "bodySnapshot";
