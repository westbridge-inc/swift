-- [R048-007] One transactional authority record per money-surface transition.
CREATE TABLE "money_surface_commands" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "actor" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "oldDigest" TEXT NOT NULL,
    "newDigest" TEXT NOT NULL,
    "decisionId" TEXT,
    "stepUpSessionId" TEXT,
    "stepUpBinding" TEXT,
    "signals" JSONB,
    "applyAt" TIMESTAMP(3),
    "leasedUntil" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "noticeKind" TEXT,
    "noticeDedupeKey" TEXT,
    "noticePayload" JSONB,
    "noticeSentAt" TIMESTAMP(3),
    "noticeAttempts" INTEGER NOT NULL DEFAULT 0,
    "noticeLastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "money_surface_commands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "money_surface_commands_entityId_generation_key" ON "money_surface_commands"("entityId", "generation");
CREATE INDEX "money_surface_commands_entityId_kind_state_idx" ON "money_surface_commands"("entityId", "kind", "state");
CREATE INDEX "money_surface_commands_state_applyAt_idx" ON "money_surface_commands"("state", "applyAt");
CREATE INDEX "money_surface_commands_noticeSentAt_createdAt_idx" ON "money_surface_commands"("noticeSentAt", "createdAt");
CREATE INDEX "money_surface_commands_tenantId_idx" ON "money_surface_commands"("tenantId");

-- [W-201] Tenant isolation, the canonical predicate (F-021-11): the bypass is
-- a ROLE, never a GUC a session could set on itself. A money-surface command
-- carries the authority to move an operator's money; it must never be readable
-- or writable through another operator's session.
ALTER TABLE "money_surface_commands" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "money_surface_commands";
CREATE POLICY "tenant_isolation" ON "money_surface_commands"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
