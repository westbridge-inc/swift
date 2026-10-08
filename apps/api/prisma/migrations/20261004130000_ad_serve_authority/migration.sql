CREATE UNIQUE INDEX "ad_creatives_id_campaignId_key" ON "ad_creatives"("id", "campaignId");
CREATE TABLE "ad_serve_grants" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "creativeId" TEXT NOT NULL,
  "placementKey" TEXT NOT NULL,
  "principalHash" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "eventMask" INTEGER NOT NULL DEFAULT 0,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('IMAGE', 'VIDEO')),
  "durationMs" INTEGER NOT NULL DEFAULT 0 CHECK ("durationMs" >= 0),
  CONSTRAINT "ad_serve_grants_campaignId_tenantId_fkey" FOREIGN KEY ("campaignId", "tenantId") REFERENCES "ad_campaigns"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ad_serve_grants_creativeId_campaignId_fkey" FOREIGN KEY ("creativeId", "campaignId") REFERENCES "ad_creatives"("id", "campaignId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ad_serve_grants_expiresAt_id_idx" ON "ad_serve_grants"("expiresAt", "id");
CREATE TABLE "ad_serve_budgets" (
  "key" TEXT PRIMARY KEY,
  "count" INTEGER NOT NULL CHECK ("count" >= 0),
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ad_serve_budgets_expiresAt_key_idx" ON "ad_serve_budgets"("expiresAt", "key");

ALTER TABLE "ad_serve_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ad_serve_grants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ad_serve_grants";
CREATE POLICY "tenant_isolation" ON "ad_serve_grants"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
