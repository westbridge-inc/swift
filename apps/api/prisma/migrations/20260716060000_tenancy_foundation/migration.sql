-- Multi-tenancy foundation (stage 1) — additive, backfilled, zero behavior change.
-- A tenant = one marketplace operator instance (the SaaS boundary). Today there
-- is exactly one; a white-label licensee is a future tenant.

CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- The single current tenant. Fixed id so the column default + FK are valid the
-- instant the columns are added and backfilled below.
INSERT INTO "tenants" ("id", "name", "slug", "isActive", "createdAt", "updatedAt")
VALUES ('swift-default', 'Swift', 'swift', true, NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;

-- Ownership roots: User, Vendor, Order. NOT NULL DEFAULT backfills existing
-- rows atomically; new rows auto-assign with no application change.
ALTER TABLE "users"   ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'swift-default';
ALTER TABLE "vendors" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'swift-default';
ALTER TABLE "orders"  ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'swift-default';

ALTER TABLE "users"   ADD CONSTRAINT "users_tenantId_fkey"   FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders"  ADD CONSTRAINT "orders_tenantId_fkey"  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "users_tenantId_idx"   ON "users"("tenantId");
CREATE INDEX "vendors_tenantId_idx" ON "vendors"("tenantId");
CREATE INDEX "orders_tenantId_idx"  ON "orders"("tenantId");
