-- [TAXI waiting charge] One ride's waiting terms (frozen at booking) and its waiting charge
-- (frozen at "Fare collected"). EXPAND only: a new, empty table and its walls.
--
-- Owner ruling, 1 Oct 2026: 500 GYD per FULL 10 minutes of waiting. The pickup wait runs from
-- the driver's arrival to the trip start; each intermediate stop's from its arrival to its
-- departure (or its skip). All waits on the trip are summed, then floor(seconds / block) x the
-- charge per block. Not counted at the final destination; a no-show is never charged. Plan:
-- swift-coordination/TAXI-MULTISTOP-PLAN-20260924.md ("OWNER OVERRIDE"); contract: CONTRACT.md §8.
--
-- INERT until TAXI_WAITING_CHARGE=1: no row is written while the switch is off, and a ride
-- without a row is never charged. Nothing on "orders" changes shape: the charge, once frozen,
-- is added to the order's own totalAmount (the route fare stays in taxiFareTotal).
--
-- FORWARD
--  1. Table "taxi_ride_waiting" (Prisma-shaped): at most one row per taxi order (unique
--     orderId), FK to orders ON DELETE CASCADE (the row goes with its ride), FK to tenants,
--     and the tenantId index.
--  2. CHECKs on the new, empty table:
--     - the terms: a whole, non-negative charge per block within the pricing bounds; a block
--       of 1..1440 minutes; an ISO currency code;
--     - the frozen facts are written together or not at all;
--     - and the charge IS the rule: minutes = seconds / 60 and charge = (seconds / (block x 60))
--       x the charge per block, in integer division (a floor for these non-negative numbers).
--       A row whose charge disagrees with its own seconds and terms cannot be written.
--  3. The tenant wall: RLS ENABLED and FORCED, with the canonical policy. The text is
--     rlsDdlFor('taxi_ride_waiting') from src/lib/tenant-rls.ts, byte for byte.
--  4. Tenant lineage: the row's tenant is its ride's tenant. The text is the taxi_ride_waiting
--     rule of tenantLineageDdl(), byte for byte (the taxi_trip_stops shape).
--  5. Frozen twice: a BEFORE UPDATE trigger refuses any change to the identity and the terms
--     once written (the passenger pays what was disclosed), and any change at all to the
--     frozen facts once frozenAt is set (a charge is frozen once, never again).
--
-- ROLLBACK (forward repair is preferred). Roll the application back first: the previous
-- application never reads this table. The guard refuses while any row exists, because the
-- disclosed terms and every frozen charge would be lost. Verified on PostgreSQL 16 (PostGIS 3.4):
-- it restores the prior schema exactly.
--   BEGIN;
--   SET LOCAL lock_timeout = '10s';
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM "taxi_ride_waiting") THEN
--       RAISE EXCEPTION 'refusing rollback: taxi rides carry waiting terms or charges that would be lost';
--     END IF;
--   END $$;
--   DROP TABLE "taxi_ride_waiting";
--   DROP FUNCTION taxi_ride_waiting_frozen();
--   DROP FUNCTION taxi_ride_waiting_tenant_matches_order();
--   DO $$ DECLARE n integer; BEGIN
--     DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261004120000_taxi_ride_waiting';
--     GET DIAGNOSTICS n = ROW_COUNT;
--     IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
--   END $$;
--   COMMIT;

SET lock_timeout = '10s';

-- 1. The table (Prisma-shaped).
-- CreateTable
CREATE TABLE "taxi_ride_waiting" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "orderId" TEXT NOT NULL,
    "chargePerBlock" DECIMAL(12,2) NOT NULL,
    "blockMinutes" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "termsVersion" INTEGER,
    "waitingSeconds" INTEGER,
    "waitingMinutes" INTEGER,
    "waitingCharge" DECIMAL(12,2),
    "frozenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "taxi_ride_waiting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "taxi_ride_waiting_orderId_key" ON "taxi_ride_waiting"("orderId");

-- CreateIndex
CREATE INDEX "taxi_ride_waiting_tenantId_idx" ON "taxi_ride_waiting"("tenantId");

-- AddForeignKey
ALTER TABLE "taxi_ride_waiting" ADD CONSTRAINT "taxi_ride_waiting_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxi_ride_waiting" ADD CONSTRAINT "taxi_ride_waiting_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. The row's own law. The terms are those the pricing schema accepts; the frozen facts come
--    together; and the charge is the rule applied to the row's own seconds and terms.
ALTER TABLE "taxi_ride_waiting" ADD CONSTRAINT "taxi_ride_waiting_charge_per_block_check" CHECK ("chargePerBlock" >= 0 AND "chargePerBlock" <= 100000000 AND "chargePerBlock" = trunc("chargePerBlock"));
ALTER TABLE "taxi_ride_waiting" ADD CONSTRAINT "taxi_ride_waiting_block_minutes_check" CHECK ("blockMinutes" BETWEEN 1 AND 1440);
ALTER TABLE "taxi_ride_waiting" ADD CONSTRAINT "taxi_ride_waiting_currency_check" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "taxi_ride_waiting" ADD CONSTRAINT "taxi_ride_waiting_frozen_together_check" CHECK (("frozenAt" IS NULL) = ("waitingSeconds" IS NULL) AND ("frozenAt" IS NULL) = ("waitingMinutes" IS NULL) AND ("frozenAt" IS NULL) = ("waitingCharge" IS NULL));
ALTER TABLE "taxi_ride_waiting" ADD CONSTRAINT "taxi_ride_waiting_charge_rule_check" CHECK ("waitingSeconds" IS NULL OR ("waitingSeconds" >= 0 AND "waitingMinutes" = "waitingSeconds" / 60 AND "waitingCharge" = ("waitingSeconds" / ("blockMinutes" * 60)) * "chargePerBlock"));

-- 3. The wall, on the row itself (enabled AND forced). Text = rlsDdlFor('taxi_ride_waiting').
ALTER TABLE "taxi_ride_waiting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "taxi_ride_waiting" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "taxi_ride_waiting";
CREATE POLICY "tenant_isolation" ON "taxi_ride_waiting"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- 4. Lineage held by the database. Text mirrored by tenantLineageDdl() in
--    src/lib/tenant-rls.ts (the test installer heals db-push environments).
CREATE OR REPLACE FUNCTION taxi_ride_waiting_tenant_matches_order() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM orders WHERE id = NEW."orderId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'taxi_ride_waiting row % names orders row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."orderId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'taxi_ride_waiting row % names tenant % but its orders row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."orderId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS taxi_ride_waiting_tenant_matches_order ON taxi_ride_waiting;
CREATE TRIGGER taxi_ride_waiting_tenant_matches_order BEFORE INSERT OR UPDATE OF "tenantId", "orderId" ON taxi_ride_waiting FOR EACH ROW EXECUTE FUNCTION taxi_ride_waiting_tenant_matches_order();

-- 5. Frozen twice. The terms are the ones disclosed at booking, so they never change; the
--    charge is frozen once at completion, so once frozenAt is set nothing frozen changes again.
--    Every UPDATE is checked (not only one that names these columns).
CREATE OR REPLACE FUNCTION taxi_ride_waiting_frozen() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
           OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
           OR NEW."chargePerBlock" IS DISTINCT FROM OLD."chargePerBlock"
           OR NEW."blockMinutes" IS DISTINCT FROM OLD."blockMinutes"
           OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
           OR NEW."termsVersion" IS DISTINCT FROM OLD."termsVersion"
           OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
          RAISE EXCEPTION 'taxi_ride_waiting row % is frozen: its ride, tenant and terms never change once written [TAXI waiting charge]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF OLD."frozenAt" IS NOT NULL AND (
             NEW."frozenAt" IS DISTINCT FROM OLD."frozenAt"
             OR NEW."waitingSeconds" IS DISTINCT FROM OLD."waitingSeconds"
             OR NEW."waitingMinutes" IS DISTINCT FROM OLD."waitingMinutes"
             OR NEW."waitingCharge" IS DISTINCT FROM OLD."waitingCharge") THEN
          RAISE EXCEPTION 'taxi_ride_waiting row % was frozen at completion: its charge never changes again [TAXI waiting charge]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS taxi_ride_waiting_frozen ON taxi_ride_waiting;
CREATE TRIGGER taxi_ride_waiting_frozen BEFORE UPDATE ON taxi_ride_waiting FOR EACH ROW EXECUTE FUNCTION taxi_ride_waiting_frozen();
