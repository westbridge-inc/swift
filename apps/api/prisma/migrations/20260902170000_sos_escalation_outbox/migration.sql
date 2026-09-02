-- [S-01] The SOS escalation outbox: one durable, retryable delivery command
-- per required channel, written with the ACTIVE commit. Inside the tenant
-- wall like the alert it belongs to (a NULL tenant is platform-only).
SET lock_timeout = '10s';

CREATE TYPE "SosEscalationChannel" AS ENUM ('OPS_PAGE', 'WAR_ROOM', 'CONTACT_SMS', 'EVIDENCE');
CREATE TYPE "SosEscalationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "sos_escalations" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "sosAlertId" TEXT NOT NULL,
  "channel" "SosEscalationChannel" NOT NULL,
  "targetKey" TEXT NOT NULL,
  "status" "SosEscalationStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 20,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastError" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "receipt" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sos_escalations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sos_escalations_sosAlertId_channel_targetKey_key" ON "sos_escalations"("sosAlertId", "channel", "targetKey");
CREATE INDEX "sos_escalations_status_availableAt_idx" ON "sos_escalations"("status", "availableAt");
CREATE INDEX "sos_escalations_tenantId_status_idx" ON "sos_escalations"("tenantId", "status");
ALTER TABLE "sos_escalations" ADD CONSTRAINT "sos_escalations_sosAlertId_fkey" FOREIGN KEY ("sosAlertId") REFERENCES "SosAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- [W-201] Tenant isolation, the canonical predicate (F-021-11).
ALTER TABLE "sos_escalations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "sos_escalations";
CREATE POLICY "tenant_isolation" ON "sos_escalations"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
