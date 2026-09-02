-- [S-06] Guardian L2/L3 state commits before notification delivery.
-- Every check-in ask is a durable delivery obligation staged with the state change.
CREATE TYPE "GuardianCheckinLevel" AS ENUM ('SOFT', 'HARD');
CREATE TYPE "GuardianCheckinRecipient" AS ENUM ('PASSENGER', 'DRIVER');
CREATE TYPE "GuardianDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');
CREATE TABLE "guardian_checkin_deliveries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "level" "GuardianCheckinLevel" NOT NULL,
    "recipient" "GuardianCheckinRecipient" NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "GuardianDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 20,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,
    "receipt" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "guardian_checkin_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guardian_checkin_deliveries_sessionId_cycleId_level_recipie_key" ON "guardian_checkin_deliveries"("sessionId", "cycleId", "level", "recipient");
CREATE INDEX "guardian_checkin_deliveries_status_availableAt_idx" ON "guardian_checkin_deliveries"("status", "availableAt");
CREATE INDEX "guardian_checkin_deliveries_tenantId_sessionId_idx" ON "guardian_checkin_deliveries"("tenantId", "sessionId");
ALTER TABLE "guardian_checkin_deliveries" ADD CONSTRAINT "guardian_checkin_deliveries_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TripSafetySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guardian_checkin_deliveries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "guardian_checkin_deliveries";
CREATE POLICY "tenant_isolation" ON "guardian_checkin_deliveries"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
