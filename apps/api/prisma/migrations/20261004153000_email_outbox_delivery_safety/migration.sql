ALTER TABLE "email_outbox"
  ADD COLUMN "userId" TEXT,
  ADD COLUMN "failedAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorHistory" JSONB NOT NULL DEFAULT '[]';

-- Existing rows predate recipient ownership. They are only permitted to
-- finish their already-committed delivery; every newly queued row supplies a
-- userId and is cancellable on account erasure.
UPDATE "email_outbox" SET "userId" = 'legacy-unattributed' WHERE "userId" IS NULL;

ALTER TABLE "email_outbox" ALTER COLUMN "userId" SET NOT NULL;

CREATE INDEX "email_outbox_userId_processedAt_idx" ON "email_outbox"("userId", "processedAt");
CREATE INDEX "email_outbox_failedAt_idx" ON "email_outbox"("failedAt");
