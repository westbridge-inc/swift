-- [ADS-ON · 4 Oct ruling] Ad destinations: the allow-list of outside websites, and who approved each ad's link.
-- Additive: new table and nullable columns only. No existing row changes; a link with no approval never serves.
CREATE TYPE "AdLinkDomainStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "ad_campaigns"
  ADD COLUMN "destinationHost" TEXT,
  ADD COLUMN "destinationApprovedByUserId" TEXT,
  ADD COLUMN "destinationApprovedAt" TIMESTAMP(3),
  ADD COLUMN "destinationCheckedAt" TIMESTAMP(3);

ALTER TABLE "house_ads"
  ADD COLUMN "destinationHost" TEXT,
  ADD COLUMN "destinationApprovedByUserId" TEXT,
  ADD COLUMN "destinationApprovedAt" TIMESTAMP(3),
  ADD COLUMN "destinationCheckedAt" TIMESTAMP(3);

CREATE TABLE "ad_link_domains" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "host" TEXT NOT NULL,
    "status" "AdLinkDomainStatus" NOT NULL DEFAULT 'PENDING',
    "reviewNotes" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_link_domains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ad_link_domains_tenantId_host_key" ON "ad_link_domains"("tenantId", "host");
CREATE INDEX "ad_link_domains_tenantId_status_idx" ON "ad_link_domains"("tenantId", "status");

-- Tenant isolation, the canonical predicate (F-021-11): the bypass is a ROLE, never a GUC a session could set on itself.
ALTER TABLE "ad_link_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ad_link_domains" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ad_link_domains";
CREATE POLICY "tenant_isolation" ON "ad_link_domains"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
