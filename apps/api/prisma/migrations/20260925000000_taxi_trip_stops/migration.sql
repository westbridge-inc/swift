-- [TAXI multi-stop 1/8] Foundation: the stop table, its walls, and two inert columns.
--
-- Owner, 09-24: "what happened to multiple drops in taxi im only seeing one". It was
-- never built. Plan and rulings: swift-coordination/TAXI-MULTISTOP-PLAN-20260924.md
-- (max 3 intermediate stops plus the final destination; no wait or per-stop fee).
--
-- INERT. Nothing reads or writes any of this yet: no route creates or returns a stop,
-- and TAXI_MAX_STOPS is not read. Every existing ride keeps "taxiStopCount" NULL (a
-- single-leg ride) and every driver keeps "taxiStopsCapable" false.
--
-- FORWARD
--  1. Enum "TaxiStopStatus" and table "taxi_trip_stops" (Prisma-shaped): one row per
--     INTERMEDIATE stop of one taxi order, sequence 1..3. The pickup and the final
--     destination stay on the order. FK to orders ON DELETE CASCADE (a ride's stops go
--     with it), FK to tenants, unique (orderId, sequence), and the tenantId index.
--  2. CHECKs on the new, empty table: sequence 1..3, lat and lng in range, address 3..200
--     characters (the request schema's bounds).
--  3. "orders"."taxiStopCount" INTEGER NULL and its CHECK (NULL, or 1..3), added NOT VALID:
--     every existing row is NULL, so there is nothing to validate, and NOT VALID spares a
--     scan of "orders" under the ACCESS EXCLUSIVE lock. New and updated rows are checked.
--     VALIDATE CONSTRAINT may be run at any time later; it does not block writes.
--  4. "drivers"."taxiStopsCapable" BOOLEAN NOT NULL DEFAULT false (a constant default:
--     catalogue-only on PostgreSQL 11+, no table rewrite).
--  5. The tenant wall: RLS ENABLED and FORCED, with the canonical policy. The text is
--     rlsDdlFor('taxi_trip_stops') from src/lib/tenant-rls.ts, byte for byte.
--  6. Tenant lineage: a stop's tenant is its order's tenant (default = unstamped, derived
--     from the order; a disagreement or an invisible order is refused). The text is the
--     taxi_trip_stops rule of tenantLineageDdl(), byte for byte, in the shape of the
--     delivery_cash_settlements precedent (20260905160000_money_tables_tenant).
--  7. Identity freeze: a BEFORE UPDATE trigger refuses any change to id, tenantId, orderId
--     or sequence. Status and its timestamps are NOT frozen: they move as the ride runs.
--
-- ROLLBACK (forward repair is preferred). Roll the application back first; this change is
-- inert, so the previous application never reads these objects. The guard refuses while
-- any multi-stop ride exists, because its stops would be discarded. Verified on
-- PostgreSQL 16 (PostGIS 3.4): it restores the prior schema exactly.
--   BEGIN;
--   SET LOCAL lock_timeout = '10s';
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM "taxi_trip_stops")
--        OR EXISTS (SELECT 1 FROM "orders" WHERE "taxiStopCount" IS NOT NULL) THEN
--       RAISE EXCEPTION 'refusing rollback: multi-stop rides exist and would lose their stops';
--     END IF;
--   END $$;
--   DROP TABLE "taxi_trip_stops";
--   DROP FUNCTION taxi_trip_stops_identity_frozen();
--   DROP FUNCTION taxi_trip_stops_tenant_matches_order();
--   DROP TYPE "TaxiStopStatus";
--   ALTER TABLE "orders" DROP CONSTRAINT "orders_taxi_stop_count_check", DROP COLUMN "taxiStopCount";
--   ALTER TABLE "drivers" DROP COLUMN "taxiStopsCapable";
--   DO $$ DECLARE n integer; BEGIN
--     DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925000000_taxi_trip_stops';
--     GET DIAGNOSTICS n = ROW_COUNT;
--     IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
--   END $$;
--   COMMIT;

SET lock_timeout = '10s';

-- 1. The stop status and the table (Prisma-shaped).
-- CreateEnum
CREATE TYPE "TaxiStopStatus" AS ENUM ('PENDING', 'ARRIVED', 'DEPARTED', 'SKIPPED');

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "taxiStopsCapable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "taxiStopCount" INTEGER;

-- CreateTable
CREATE TABLE "taxi_trip_stops" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "orderId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "address" TEXT NOT NULL,
    "legMeters" INTEGER,
    "legSeconds" INTEGER,
    "status" "TaxiStopStatus" NOT NULL DEFAULT 'PENDING',
    "arrivedAt" TIMESTAMP(3),
    "departedAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "skipReason" TEXT,
    "actedBy" TEXT,
    "evidenceNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "taxi_trip_stops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "taxi_trip_stops_tenantId_idx" ON "taxi_trip_stops"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "taxi_trip_stops_orderId_sequence_key" ON "taxi_trip_stops"("orderId", "sequence");

-- AddForeignKey
ALTER TABLE "taxi_trip_stops" ADD CONSTRAINT "taxi_trip_stops_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxi_trip_stops" ADD CONSTRAINT "taxi_trip_stops_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. The stop row's own bounds. At most 3 intermediate stops, numbered from 1; a real
--    coordinate; an address the request schema would accept (3..200 characters).
ALTER TABLE "taxi_trip_stops" ADD CONSTRAINT "taxi_trip_stops_sequence_check" CHECK ("sequence" BETWEEN 1 AND 3);
ALTER TABLE "taxi_trip_stops" ADD CONSTRAINT "taxi_trip_stops_lat_check" CHECK ("lat" BETWEEN -90 AND 90);
ALTER TABLE "taxi_trip_stops" ADD CONSTRAINT "taxi_trip_stops_lng_check" CHECK ("lng" BETWEEN -180 AND 180);
ALTER TABLE "taxi_trip_stops" ADD CONSTRAINT "taxi_trip_stops_address_check" CHECK (char_length(btrim("address")) >= 3 AND char_length("address") <= 200);

-- 3. The order header: NULL is a single-leg ride (every ride today); else 1..3 stops.
ALTER TABLE "orders" ADD CONSTRAINT "orders_taxi_stop_count_check" CHECK ("taxiStopCount" IS NULL OR "taxiStopCount" BETWEEN 1 AND 3) NOT VALID;

-- 5. The wall, on the row itself (enabled AND forced). Text = rlsDdlFor('taxi_trip_stops').
ALTER TABLE "taxi_trip_stops" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "taxi_trip_stops" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "taxi_trip_stops";
CREATE POLICY "tenant_isolation" ON "taxi_trip_stops"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- 6. Lineage held by the database. Text mirrored by tenantLineageDdl() in
--    src/lib/tenant-rls.ts (the test installer heals db-push environments).
CREATE OR REPLACE FUNCTION taxi_trip_stops_tenant_matches_order() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM orders WHERE id = NEW."orderId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'taxi_trip_stops row % names orders row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."orderId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'taxi_trip_stops row % names tenant % but its orders row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."orderId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS taxi_trip_stops_tenant_matches_order ON taxi_trip_stops;
CREATE TRIGGER taxi_trip_stops_tenant_matches_order BEFORE INSERT OR UPDATE OF "tenantId", "orderId" ON taxi_trip_stops FOR EACH ROW EXECUTE FUNCTION taxi_trip_stops_tenant_matches_order();

-- 7. The itinerary is frozen at request. A stop is never moved to another ride, another
--    tenant or another place in the order: a different itinerary is a different request.
--    Every UPDATE is checked (not only an UPDATE that names these columns), so a cascaded
--    key rewrite is refused too. Status, its timestamps, the skip reason, the actor and
--    the evidence note stay writable: they are how the ride progresses.
CREATE OR REPLACE FUNCTION taxi_trip_stops_identity_frozen() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
           OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
           OR NEW."sequence" IS DISTINCT FROM OLD."sequence" THEN
          RAISE EXCEPTION 'taxi_trip_stops row % is frozen: id, tenantId, orderId and sequence never change once written [TAXI multi-stop]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS taxi_trip_stops_identity_frozen ON taxi_trip_stops;
CREATE TRIGGER taxi_trip_stops_identity_frozen BEFORE UPDATE ON taxi_trip_stops FOR EACH ROW EXECUTE FUNCTION taxi_trip_stops_identity_frozen();
