-- Rollback for 20261015200000_user_inactivity_notice: the notice dates go with the column;
-- a person told before the rollback is simply told again by the next sweep after a re-apply.
ALTER TABLE "users" DROP COLUMN IF EXISTS "inactivityNoticeAt";
