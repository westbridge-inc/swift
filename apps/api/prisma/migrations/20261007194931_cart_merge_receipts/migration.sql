CREATE TABLE "cart_merge_receipts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "cart_merge_receipts_tenantId_userId_idempotencyKey_key"
  ON "cart_merge_receipts"("tenantId", "userId", "idempotencyKey");
CREATE INDEX "cart_merge_receipts_tenantId_idx" ON "cart_merge_receipts"("tenantId");
ALTER TABLE "cart_merge_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cart_merge_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cart_merge_receipts"
  USING ("tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'));
