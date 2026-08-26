-- [REPORT-034 #30] Notification idempotency: a caller-supplied dedupe key.
-- Additive only. NULL keys are unlimited (Postgres unique treats NULLs as
-- distinct), so every existing caller and row is untouched; callers that pass
-- a deterministic key (retried jobs) get exactly-once inbox/push semantics.
ALTER TABLE "notifications" ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "notifications_userId_dedupeKey_key" ON "notifications"("userId", "dedupeKey");
