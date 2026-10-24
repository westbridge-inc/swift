-- [S2-29 · KYC-DECISION-ATOMIC] The work a committed document approval still owes (the trial
-- decision), written in the decision's own transaction and drained after commit.
CREATE TABLE "verification_decision_outbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "maxAttempts" INTEGER NOT NULL DEFAULT 25,
    "deadLetteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_decision_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "verification_decision_outbox_documentId_command_key" ON "verification_decision_outbox"("documentId", "command");
CREATE INDEX "verification_decision_outbox_processedAt_availableAt_idx" ON "verification_decision_outbox"("processedAt", "availableAt");

-- A decision's outbox row belongs to the document's tenant: the same wall, the same shape as
-- every tenant table (rating_outbox, order_outbox).
CREATE INDEX "verification_decision_outbox_tenantId_idx" ON "verification_decision_outbox"("tenantId");
ALTER TABLE "verification_decision_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification_decision_outbox" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "verification_decision_outbox";
CREATE POLICY "tenant_isolation" ON "verification_decision_outbox"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
