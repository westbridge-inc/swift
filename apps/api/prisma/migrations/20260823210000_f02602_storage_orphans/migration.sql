-- [F-026-02] Durable storage-deletion census: a failed avatar/selfie object
-- delete (upload unwind, account deletion, pointer replacement) must land in
-- a retryable table, not a log line — once users.avatar is nulled/replaced,
-- nothing else can rediscover the key.
SET lock_timeout = '10s';

CREATE TABLE "storage_orphans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "storage_orphans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "storage_orphans_key_key" ON "storage_orphans"("key");
CREATE INDEX "storage_orphans_tenantId_purgedAt_idx" ON "storage_orphans"("tenantId", "purgedAt");

-- Tenant wall, current (role-capability) predicate — same as rlsDdlFor().
ALTER TABLE "storage_orphans" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "storage_orphans";
CREATE POLICY "tenant_isolation" ON "storage_orphans"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
