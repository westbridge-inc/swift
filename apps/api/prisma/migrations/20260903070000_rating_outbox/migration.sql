-- [R048-008] The commands a persisted rating still owes, written in its own transaction.
CREATE TABLE "rating_outbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "ratingId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rating_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rating_outbox_ratingId_command_key" ON "rating_outbox"("ratingId", "command");
CREATE INDEX "rating_outbox_processedAt_availableAt_idx" ON "rating_outbox"("processedAt", "availableAt");

-- [R048-008] A rating outbox row carries a rating's pending safety escalation:
-- it never crosses a market. Same wall, same shape as every tenant table.
CREATE INDEX "rating_outbox_tenantId_idx" ON "rating_outbox"("tenantId");
ALTER TABLE "rating_outbox" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "rating_outbox";
CREATE POLICY "tenant_isolation" ON "rating_outbox"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
