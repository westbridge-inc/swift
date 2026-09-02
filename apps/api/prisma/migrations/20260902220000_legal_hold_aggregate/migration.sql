-- [S-09] Police legal hold and evidence hold are split.
-- One transactional aggregate spanning the case, its evidence, the custody log and the vault outbox.
CREATE TYPE "LegalHoldVaultStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');
CREATE TABLE "legal_holds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "caseId" TEXT NOT NULL,
    "bundleId" TEXT,
    "placedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vaultStatus" "LegalHoldVaultStatus" NOT NULL DEFAULT 'PENDING',
    "vaultAttempts" INTEGER NOT NULL DEFAULT 0,
    "vaultAvailableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vaultLastError" TEXT,
    "vaultedAt" TIMESTAMP(3),
    "manifest" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "legal_holds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "legal_holds_caseId_key" ON "legal_holds"("caseId");
CREATE INDEX "legal_holds_vaultStatus_vaultAvailableAt_idx" ON "legal_holds"("vaultStatus", "vaultAvailableAt");
CREATE INDEX "legal_holds_tenantId_caseId_idx" ON "legal_holds"("tenantId", "caseId");
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "IncidentCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "legal_holds" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "legal_holds";
CREATE POLICY "tenant_isolation" ON "legal_holds"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
