-- [S-19] War-room socket membership is not delivery acknowledgement.
-- An ops page is a durable obligation with per-recipient delivery and acknowledgement.
CREATE TYPE "OpsAlertKind" AS ENUM ('SOS', 'DRILL');
CREATE TABLE "ops_alerts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "kind" "OpsAlertKind" NOT NULL,
    "sosAlertId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ackDeadlineAt" TIMESTAMP(3) NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "lastEscalatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ops_alerts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ops_alerts_acknowledgedAt_closedAt_ackDeadlineAt_idx" ON "ops_alerts"("acknowledgedAt", "closedAt", "ackDeadlineAt");
CREATE INDEX "ops_alerts_tenantId_createdAt_idx" ON "ops_alerts"("tenantId", "createdAt");
CREATE INDEX "ops_alerts_sosAlertId_idx" ON "ops_alerts"("sosAlertId");
CREATE TABLE "ops_alert_recipients" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "opsAlertId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notificationId" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "seenAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),
    "smsSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ops_alert_recipients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ops_alert_recipients_opsAlertId_userId_key" ON "ops_alert_recipients"("opsAlertId", "userId");
CREATE INDEX "ops_alert_recipients_tenantId_opsAlertId_idx" ON "ops_alert_recipients"("tenantId", "opsAlertId");
CREATE INDEX "ops_alert_recipients_notificationId_idx" ON "ops_alert_recipients"("notificationId");
ALTER TABLE "ops_alert_recipients" ADD CONSTRAINT "ops_alert_recipients_opsAlertId_fkey" FOREIGN KEY ("opsAlertId") REFERENCES "ops_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ops_alerts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ops_alerts";
CREATE POLICY "tenant_isolation" ON "ops_alerts"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "ops_alert_recipients" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ops_alert_recipients";
CREATE POLICY "tenant_isolation" ON "ops_alert_recipients"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
