-- [STA-1 §4 lineage] Items and categories are walled on the row itself.
--
-- A child table that carries no tenantId is walled only through its parent:
-- one relation filter that forgets the tenant reaches every tenant's rows.
-- That is how a reviewer's home listed a real vendor's dishes (2026-09-05).
-- The exemplar EXPAND for the child-table contract: the column with the
-- default that describes every existing row, a backfill from the parent so
-- the column is TRUE and not merely present, the wall (RLS + FORCE + policy),
-- both registries (TENANT_TABLES, TENANT_QUERY_EXTENSIONS), and a trigger
-- that holds a row's tenant equal to its parent's: a row left at the default
-- (unstamped) is derived from its vendor; an explicit tenant that disagrees
-- with the vendor, or a vendor not visible from this tenant, is refused.
--
-- Expand only. PostgreSQL adds a defaulted NOT NULL column without rewriting
-- the table; the backfill touches only rows whose vendor is not in the default
-- tenant (none exist before the review tenant is provisioned).

-- 1. The column, defaulted to the tenant every existing row belongs to.
ALTER TABLE "categories" ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT 'swift-default';
ALTER TABLE "items" ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT 'swift-default';

-- 2. The truth: a child's tenant is its vendor's tenant.
UPDATE "categories" c SET "tenantId" = v."tenantId" FROM "vendors" v WHERE v.id = c."vendorId" AND c."tenantId" <> v."tenantId";
UPDATE "items" i SET "tenantId" = v."tenantId" FROM "vendors" v WHERE v.id = i."vendorId" AND i."tenantId" <> v."tenantId";

-- 3. Indexes and the tenant FK (Prisma-shaped).
CREATE INDEX "categories_tenantId_idx" ON "categories"("tenantId");
CREATE INDEX "items_tenantId_idx" ON "items"("tenantId");
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "items" ADD CONSTRAINT "items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. The wall, on the row itself (Part 4.2: enabled AND forced).
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "categories";
CREATE POLICY "tenant_isolation" ON "categories"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "items";
CREATE POLICY "tenant_isolation" ON "items"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- 5. Lineage held by the database. Text mirrored by tenantLineageDdl() in
--    src/lib/tenant-rls.ts (the test installer heals db-push environments).
CREATE OR REPLACE FUNCTION categories_tenant_matches_vendor() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" INTO parent_tenant FROM vendors WHERE id = NEW."vendorId";
        IF parent_tenant IS NULL THEN
          RAISE EXCEPTION 'categories row % names vendors row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."vendorId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'categories row % names tenant % but its vendors row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."vendorId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS categories_tenant_matches_vendor ON categories;
CREATE TRIGGER categories_tenant_matches_vendor BEFORE INSERT OR UPDATE OF "tenantId", "vendorId" ON categories FOR EACH ROW EXECUTE FUNCTION categories_tenant_matches_vendor();
CREATE OR REPLACE FUNCTION items_tenant_matches_vendor() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" INTO parent_tenant FROM vendors WHERE id = NEW."vendorId";
        IF parent_tenant IS NULL THEN
          RAISE EXCEPTION 'items row % names vendors row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."vendorId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'items row % names tenant % but its vendors row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."vendorId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS items_tenant_matches_vendor ON items;
CREATE TRIGGER items_tenant_matches_vendor BEFORE INSERT OR UPDATE OF "tenantId", "vendorId" ON items FOR EACH ROW EXECUTE FUNCTION items_tenant_matches_vendor();
