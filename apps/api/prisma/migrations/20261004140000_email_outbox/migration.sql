CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_outbox_dedupeKey_key" ON "email_outbox"("dedupeKey");
CREATE INDEX "email_outbox_processedAt_availableAt_idx" ON "email_outbox"("processedAt", "availableAt");
CREATE INDEX "email_outbox_claimedAt_idx" ON "email_outbox"("claimedAt");
