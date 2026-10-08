-- [DB-05 EXPAND] Three ownership tables leave PENDING_EXPAND and are walled on the row.
--
-- ReturnRequest, ContentReport and CollectionContact reached a tenant only
-- through loose owner strings: no tenantId, no structural parent. EXPAND only:
--   1. a NULLABLE tenantId (no default: an unstamped row is NULL, never
--      silently the production tenant), its index and the tenant FK;
--   2. the backfill: each row takes the tenant its owners agree on, by the
--      SAME derivation the lineage trigger runs (lineageBackfillSql); a row
--      whose owners disagree or are gone stays NULL - quarantined, invisible
--      to every tenant - and is counted below for adjudication;
--   3. the wall: RLS enabled AND forced, the canonical tenant policy;
--   4. lineage held by the database: a new row is stamped from its owners,
--      a row whose owners do not resolve is refused, and an explicit tenant
--      that disagrees with them is refused.
-- Old binaries stay compatible: they never name tenantId, and the trigger
-- derives it. CONTRACT (NOT NULL) is a later migration, after adjudication.
-- Text mirrored by src/lib/tenant-rls.ts (the test installer heals db-push
-- environments, and the DB-05 suite checks this file carries that text).

-- 1. The column, its index and the tenant FK (Prisma-shaped).
ALTER TABLE "return_requests" ADD COLUMN     "tenantId" TEXT;
ALTER TABLE "content_reports" ADD COLUMN     "tenantId" TEXT;
ALTER TABLE "collection_contacts" ADD COLUMN     "tenantId" TEXT;
CREATE INDEX "return_requests_tenantId_idx" ON "return_requests"("tenantId");
CREATE INDEX "content_reports_tenantId_idx" ON "content_reports"("tenantId");
CREATE INDEX "collection_contacts_tenantId_idx" ON "collection_contacts"("tenantId");
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "collection_contacts" ADD CONSTRAINT "collection_contacts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. The backfill, by the trigger's own derivation; disagreeing or missing owners stay NULL.
UPDATE return_requests AS lineage_row SET "tenantId" = (SELECT o."tenantId" FROM orders o JOIN users u ON u.id = lineage_row."customerId" WHERE o.id = lineage_row."orderId" AND u."tenantId" = o."tenantId") WHERE lineage_row."tenantId" IS NULL;
UPDATE content_reports AS lineage_row SET "tenantId" = (SELECT "tenantId" FROM users WHERE id = lineage_row."reporterId") WHERE lineage_row."tenantId" IS NULL;
UPDATE collection_contacts AS lineage_row SET "tenantId" = (SELECT CASE WHEN count(DISTINCT owners.t) = 1 THEN min(owners.t) END FROM (SELECT v."tenantId" AS t FROM subscriptions s JOIN vendors v ON v.id = s."vendorId" WHERE s.id = lineage_row."subscriptionId" UNION ALL SELECT u."tenantId" FROM subscriptions s JOIN riders r ON r.id = s."riderId" JOIN users u ON u.id = r."userId" WHERE s.id = lineage_row."subscriptionId" UNION ALL SELECT u."tenantId" FROM subscriptions s JOIN drivers d ON d.id = s."driverId" JOIN users u ON u.id = d."userId" WHERE s.id = lineage_row."subscriptionId") owners) WHERE lineage_row."tenantId" IS NULL;
DO $$ DECLARE q_rr bigint; q_cr bigint; q_cc bigint; BEGIN
  SELECT count(*) INTO q_rr FROM return_requests WHERE "tenantId" IS NULL;
  SELECT count(*) INTO q_cr FROM content_reports WHERE "tenantId" IS NULL;
  SELECT count(*) INTO q_cc FROM collection_contacts WHERE "tenantId" IS NULL;
  RAISE NOTICE '[DB-05] quarantined (tenantId NULL, for adjudication): return_requests=%, content_reports=%, collection_contacts=%', q_rr, q_cr, q_cc;
END $$;

-- 3. The wall, on the row itself (enabled AND forced, the canonical policy).
ALTER TABLE "return_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "return_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "return_requests";
CREATE POLICY "tenant_isolation" ON "return_requests"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "content_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "content_reports" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "content_reports";
CREATE POLICY "tenant_isolation" ON "content_reports"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "collection_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "collection_contacts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "collection_contacts";
CREATE POLICY "tenant_isolation" ON "collection_contacts"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- 4. Lineage held by the database (tenantLineageDdl).
CREATE OR REPLACE FUNCTION return_requests_tenant_matches_order() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT o."tenantId" FROM orders o JOIN users u ON u.id = NEW."customerId" WHERE o.id = NEW."orderId" AND u."tenantId" = o."tenantId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'return_requests row % names orders row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."orderId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" IS NULL OR (NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default') THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'return_requests row % names tenant % but its orders row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."orderId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS return_requests_tenant_matches_order ON return_requests;
CREATE TRIGGER return_requests_tenant_matches_order BEFORE INSERT OR UPDATE OF "tenantId", "orderId", "customerId" ON return_requests FOR EACH ROW EXECUTE FUNCTION return_requests_tenant_matches_order();
CREATE OR REPLACE FUNCTION content_reports_tenant_matches_reporter() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM users WHERE id = NEW."reporterId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'content_reports row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."reporterId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" IS NULL OR (NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default') THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'content_reports row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."reporterId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_reports_tenant_matches_reporter ON content_reports;
CREATE TRIGGER content_reports_tenant_matches_reporter BEFORE INSERT OR UPDATE OF "tenantId", "reporterId" ON content_reports FOR EACH ROW EXECUTE FUNCTION content_reports_tenant_matches_reporter();
CREATE OR REPLACE FUNCTION collection_contacts_tenant_matches_owner() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT CASE WHEN count(DISTINCT owners.t) = 1 THEN min(owners.t) END FROM (SELECT v."tenantId" AS t FROM subscriptions s JOIN vendors v ON v.id = s."vendorId" WHERE s.id = NEW."subscriptionId" UNION ALL SELECT u."tenantId" FROM subscriptions s JOIN riders r ON r.id = s."riderId" JOIN users u ON u.id = r."userId" WHERE s.id = NEW."subscriptionId" UNION ALL SELECT u."tenantId" FROM subscriptions s JOIN drivers d ON d.id = s."driverId" JOIN users u ON u.id = d."userId" WHERE s.id = NEW."subscriptionId") owners INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'collection_contacts row % names subscriptions row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."subscriptionId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" IS NULL OR (NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default') THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'collection_contacts row % names tenant % but its subscriptions row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."subscriptionId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS collection_contacts_tenant_matches_owner ON collection_contacts;
CREATE TRIGGER collection_contacts_tenant_matches_owner BEFORE INSERT OR UPDATE OF "tenantId", "subscriptionId" ON collection_contacts FOR EACH ROW EXECUTE FUNCTION collection_contacts_tenant_matches_owner();
