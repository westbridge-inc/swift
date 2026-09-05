-- [STA-1 §4 lineage · money] Six money tables are walled on the row itself.
--
-- Wave 2 of the child-table contract (#1144 was the exemplar): a person's or
-- an operator's money rows carried no tenantId and were walled only through
-- their owner. Same pattern: the defaulted column, a backfill from the owner
-- so the column is TRUE, the wall (RLS + FORCE + policy), both registries, and
-- a lineage trigger per table (default = unstamped → derived from the owner;
-- an explicit disagreement, or an owner not visible from this tenant → refused).
-- Earnings inherit through their mover — rider OR driver — to that person.
--
-- Expand only. The backfill touches only rows whose owner is outside the
-- default tenant (none exist before the review tenant is provisioned).

-- 1. The column, defaulted to the tenant every existing row belongs to.
ALTER TABLE "delivery_cash_settlements" ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT 'swift-default';
ALTER TABLE "earnings" ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT 'swift-default';
ALTER TABLE "payout_requests" ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT 'swift-default';
ALTER TABLE "payout_schedules" ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT 'swift-default';
ALTER TABLE "settlements" ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT 'swift-default';
ALTER TABLE "transactions" ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT 'swift-default';

-- 2. The truth: a money row's tenant is its owner's tenant.
UPDATE "transactions" t SET "tenantId" = u."tenantId" FROM "users" u WHERE u.id = t."userId" AND t."tenantId" <> u."tenantId";
UPDATE "payout_requests" p SET "tenantId" = u."tenantId" FROM "users" u WHERE u.id = p."userId" AND p."tenantId" <> u."tenantId";
UPDATE "payout_schedules" p SET "tenantId" = u."tenantId" FROM "users" u WHERE u.id = p."userId" AND p."tenantId" <> u."tenantId";
UPDATE "settlements" s SET "tenantId" = v."tenantId" FROM "vendors" v WHERE v.id = s."vendorId" AND s."tenantId" <> v."tenantId";
UPDATE "delivery_cash_settlements" d SET "tenantId" = o."tenantId" FROM "orders" o WHERE o.id = d."orderId" AND d."tenantId" <> o."tenantId";
UPDATE "earnings" e SET "tenantId" = u."tenantId"
  FROM "users" u
 WHERE u.id = COALESCE((SELECT r."userId" FROM "riders" r WHERE r.id = e."riderId"), (SELECT d."userId" FROM "drivers" d WHERE d.id = e."driverId"))
   AND e."tenantId" <> u."tenantId";

-- 3. Indexes and the tenant FKs (Prisma-shaped).
CREATE INDEX "delivery_cash_settlements_tenantId_idx" ON "delivery_cash_settlements"("tenantId");
CREATE INDEX "earnings_tenantId_idx" ON "earnings"("tenantId");
CREATE INDEX "payout_requests_tenantId_idx" ON "payout_requests"("tenantId");
CREATE INDEX "payout_schedules_tenantId_idx" ON "payout_schedules"("tenantId");
CREATE INDEX "settlements_tenantId_idx" ON "settlements"("tenantId");
CREATE INDEX "transactions_tenantId_idx" ON "transactions"("tenantId");
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_cash_settlements" ADD CONSTRAINT "delivery_cash_settlements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payout_schedules" ADD CONSTRAINT "payout_schedules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. The wall, on the row itself (Part 4.2: enabled AND forced).
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transactions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "transactions";
CREATE POLICY "tenant_isolation" ON "transactions"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "earnings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "earnings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "earnings";
CREATE POLICY "tenant_isolation" ON "earnings"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settlements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "settlements";
CREATE POLICY "tenant_isolation" ON "settlements"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "delivery_cash_settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_cash_settlements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "delivery_cash_settlements";
CREATE POLICY "tenant_isolation" ON "delivery_cash_settlements"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "payout_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payout_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "payout_requests";
CREATE POLICY "tenant_isolation" ON "payout_requests"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "payout_schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payout_schedules" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "payout_schedules";
CREATE POLICY "tenant_isolation" ON "payout_schedules"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- 5. Lineage held by the database. Text mirrored by tenantLineageDdl() in
--    src/lib/tenant-rls.ts (the test installer heals db-push environments).
CREATE OR REPLACE FUNCTION transactions_tenant_matches_user() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM users WHERE id = NEW."userId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          RAISE EXCEPTION 'transactions row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."userId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'transactions row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."userId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS transactions_tenant_matches_user ON transactions;
CREATE TRIGGER transactions_tenant_matches_user BEFORE INSERT OR UPDATE OF "tenantId", "userId" ON transactions FOR EACH ROW EXECUTE FUNCTION transactions_tenant_matches_user();
CREATE OR REPLACE FUNCTION payout_requests_tenant_matches_user() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM users WHERE id = NEW."userId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          RAISE EXCEPTION 'payout_requests row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."userId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'payout_requests row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."userId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payout_requests_tenant_matches_user ON payout_requests;
CREATE TRIGGER payout_requests_tenant_matches_user BEFORE INSERT OR UPDATE OF "tenantId", "userId" ON payout_requests FOR EACH ROW EXECUTE FUNCTION payout_requests_tenant_matches_user();
CREATE OR REPLACE FUNCTION payout_schedules_tenant_matches_user() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM users WHERE id = NEW."userId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          RAISE EXCEPTION 'payout_schedules row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."userId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'payout_schedules row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."userId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payout_schedules_tenant_matches_user ON payout_schedules;
CREATE TRIGGER payout_schedules_tenant_matches_user BEFORE INSERT OR UPDATE OF "tenantId", "userId" ON payout_schedules FOR EACH ROW EXECUTE FUNCTION payout_schedules_tenant_matches_user();
CREATE OR REPLACE FUNCTION settlements_tenant_matches_vendor() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM vendors WHERE id = NEW."vendorId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          RAISE EXCEPTION 'settlements row % names vendors row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."vendorId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'settlements row % names tenant % but its vendors row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."vendorId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS settlements_tenant_matches_vendor ON settlements;
CREATE TRIGGER settlements_tenant_matches_vendor BEFORE INSERT OR UPDATE OF "tenantId", "vendorId" ON settlements FOR EACH ROW EXECUTE FUNCTION settlements_tenant_matches_vendor();
CREATE OR REPLACE FUNCTION delivery_cash_settlements_tenant_matches_order() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM orders WHERE id = NEW."orderId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          RAISE EXCEPTION 'delivery_cash_settlements row % names orders row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."orderId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'delivery_cash_settlements row % names tenant % but its orders row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."orderId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS delivery_cash_settlements_tenant_matches_order ON delivery_cash_settlements;
CREATE TRIGGER delivery_cash_settlements_tenant_matches_order BEFORE INSERT OR UPDATE OF "tenantId", "orderId" ON delivery_cash_settlements FOR EACH ROW EXECUTE FUNCTION delivery_cash_settlements_tenant_matches_order();
CREATE OR REPLACE FUNCTION earnings_tenant_matches_mover() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT u."tenantId" FROM users u WHERE u.id = COALESCE((SELECT r."userId" FROM riders r WHERE r.id = NEW."riderId"), (SELECT d."userId" FROM drivers d WHERE d.id = NEW."driverId")) INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          RAISE EXCEPTION 'earnings row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."riderId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'earnings row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."riderId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS earnings_tenant_matches_mover ON earnings;
CREATE TRIGGER earnings_tenant_matches_mover BEFORE INSERT OR UPDATE OF "tenantId", "riderId", "driverId" ON earnings FOR EACH ROW EXECUTE FUNCTION earnings_tenant_matches_mover();
