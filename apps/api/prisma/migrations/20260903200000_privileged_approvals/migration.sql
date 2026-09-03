-- [ADM-005] Dual control on money and platform actions.
--
-- A settlement processed, a fee waived, a top-up granted or an invoice marked
-- paid, all on ONE actor's request. The only approval model in the schema
-- gates the autonomous agent, not a human. This is the general record: what
-- was asked, by whom, with what reason, over exactly which request — and who,
-- other than the requester, agreed to it.
--
-- The fingerprint binds the approval to the request that was reviewed, so an
-- approved settlement cannot be re-aimed at a different beneficiary or amount
-- between the decision and the act.
CREATE TABLE "privileged_approvals" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT NOT NULL DEFAULT 'swift-default',
  "action"       TEXT NOT NULL,
  "cls"          TEXT NOT NULL,
  "capability"   TEXT NOT NULL,
  "entityId"     TEXT,
  "fingerprint"  TEXT NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'PENDING',
  "requestedBy"  TEXT NOT NULL,
  "reason"       TEXT NOT NULL,
  "approvedBy"   TEXT,
  "decisionNote" TEXT,
  "decidedAt"    TIMESTAMP(3),
  "appliedAt"    TIMESTAMP(3),
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "privileged_approvals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "privileged_approvals_tenantId_idx" ON "privileged_approvals"("tenantId");
CREATE INDEX "privileged_approvals_status_createdAt_idx" ON "privileged_approvals"("status", "createdAt");
CREATE INDEX "privileged_approvals_fingerprint_idx" ON "privileged_approvals"("fingerprint");

-- Tenant isolation, the same shape money_surface_commands carries: an approval
-- authorises money to move, so it must never be readable or writable through
-- another operator's session.
ALTER TABLE "privileged_approvals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "privileged_approvals";
CREATE POLICY "tenant_isolation" ON "privileged_approvals"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
