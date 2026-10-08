-- [DB-05 EXPAND] Reverse of migration.sql: the lineage triggers, the wall and
-- the tenantId column (its index and FK) go; every row and every other column
-- stays. The tables return to PENDING_EXPAND (walled only by the application
-- predicates they had before).
BEGIN;
DROP TRIGGER IF EXISTS return_requests_tenant_matches_order ON return_requests;
DROP FUNCTION IF EXISTS return_requests_tenant_matches_order();
DROP TRIGGER IF EXISTS content_reports_tenant_matches_reporter ON content_reports;
DROP FUNCTION IF EXISTS content_reports_tenant_matches_reporter();
DROP TRIGGER IF EXISTS collection_contacts_tenant_matches_owner ON collection_contacts;
DROP FUNCTION IF EXISTS collection_contacts_tenant_matches_owner();
DROP POLICY IF EXISTS "tenant_isolation" ON "return_requests";
DROP POLICY IF EXISTS "tenant_isolation" ON "content_reports";
DROP POLICY IF EXISTS "tenant_isolation" ON "collection_contacts";
ALTER TABLE "return_requests" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "return_requests" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "content_reports" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "content_reports" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "collection_contacts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "collection_contacts" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "return_requests" DROP CONSTRAINT IF EXISTS "return_requests_tenantId_fkey";
ALTER TABLE "content_reports" DROP CONSTRAINT IF EXISTS "content_reports_tenantId_fkey";
ALTER TABLE "collection_contacts" DROP CONSTRAINT IF EXISTS "collection_contacts_tenantId_fkey";
DROP INDEX IF EXISTS "return_requests_tenantId_idx";
DROP INDEX IF EXISTS "content_reports_tenantId_idx";
DROP INDEX IF EXISTS "collection_contacts_tenantId_idx";
ALTER TABLE "return_requests" DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "content_reports" DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "collection_contacts" DROP COLUMN IF EXISTS "tenantId";
COMMIT;
