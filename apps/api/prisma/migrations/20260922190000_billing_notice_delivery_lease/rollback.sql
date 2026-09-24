-- Source rollback only. Execute on an isolated database after forward-migration
-- proof; never drop these checkpoints after a live notice has been staged.
SET lock_timeout = '10s';
DROP INDEX IF EXISTS "billing_events_notice_lease_idx";
ALTER TABLE "billing_events"
  DROP COLUMN IF EXISTS "noticeSmsSentAt",
  DROP COLUMN IF EXISTS "noticeLeaseToken",
  DROP COLUMN IF EXISTS "noticeLeaseUntil";
