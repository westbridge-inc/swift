BEGIN;

CREATE TABLE "mover_revocation_outbox" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mover_revocation_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mover_revocation_outbox_dedupeKey_key"
ON "mover_revocation_outbox"("dedupeKey");

CREATE INDEX "mover_revocation_outbox_processedAt_availableAt_idx"
ON "mover_revocation_outbox"("processedAt", "availableAt");

CREATE INDEX "mover_revocation_outbox_claimedAt_idx"
ON "mover_revocation_outbox"("claimedAt");

COMMIT;
