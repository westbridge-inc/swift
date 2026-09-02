-- [M-08] The prepaid top-up is one persisted command: the admin's idempotency
-- key and the request's fingerprint, the credit's evidence (its billing
-- event), the stored result, and the durable downstream tail. Additive: one
-- new table, no existing row changes.
SET lock_timeout = '10s';

CREATE TABLE "topup_commands" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL DEFAULT 'swift-default',
    "adminId"        TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash"    TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "amount"         DECIMAL(12,2) NOT NULL,
    "reference"      TEXT,
    "billingEventId" TEXT NOT NULL,
    "result"         JSONB NOT NULL,
    "tailAttempts"   INTEGER NOT NULL DEFAULT 0,
    "tailDoneAt"     TIMESTAMP(3),
    "lastError"      TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topup_commands_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "topup_commands_billingEventId_key" ON "topup_commands"("billingEventId");
CREATE UNIQUE INDEX "topup_commands_adminId_idempotencyKey_key" ON "topup_commands"("adminId", "idempotencyKey");
CREATE INDEX "topup_commands_tenantId_idx" ON "topup_commands"("tenantId");
CREATE INDEX "topup_commands_tailDoneAt_createdAt_idx" ON "topup_commands"("tailDoneAt", "createdAt");

-- [W-201] Tenant isolation, the canonical predicate (F-021-11): the bypass is
-- a ROLE, never a GUC a session could set on itself.
ALTER TABLE "topup_commands" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "topup_commands";
CREATE POLICY "tenant_isolation" ON "topup_commands"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
