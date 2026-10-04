DROP INDEX IF EXISTS "email_outbox_failedAt_idx";
DROP INDEX IF EXISTS "email_outbox_userId_processedAt_idx";
ALTER TABLE "email_outbox"
  DROP COLUMN IF EXISTS "lastErrorHistory",
  DROP COLUMN IF EXISTS "cancelledAt",
  DROP COLUMN IF EXISTS "failedAt",
  DROP COLUMN IF EXISTS "userId";
