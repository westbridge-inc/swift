-- Rollback for 20261025190000_ops_alert_repage_bounds
-- Roll back the CODE first: the ops-alert ladder reads and writes these columns on every
-- safety tick; dropping them under it fails the escalation sweep. The old code re-pages every
-- recipient and texts on-call on every escalation (no backoff, no per-person cap).
SET lock_timeout = '10s';
DROP INDEX IF EXISTS "ops_alert_recipients_userId_lastPagedAt_idx";
ALTER TABLE "ops_alert_recipients" DROP COLUMN IF EXISTS "lastPagedAt";
ALTER TABLE "ops_alert_recipients" DROP COLUMN IF EXISTS "pagedLevel";
ALTER TABLE "ops_alerts" DROP COLUMN IF EXISTS "oncallTextedList";
ALTER TABLE "ops_alerts" DROP COLUMN IF EXISTS "oncallTextedAt";
ALTER TABLE "ops_alerts" DROP COLUMN IF EXISTS "oncallTextedLevel";
