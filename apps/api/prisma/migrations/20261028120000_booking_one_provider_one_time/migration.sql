-- [BOOK-S1 "One provider, one time" · COORD C1(a)] A booking takes the BUSINESS's time.
--
-- Until now the only double-booking guard was per LISTING (the partial unique on
-- (itemId, slotStart)): one person who lists "Haircut" and "Beard trim" could be booked
-- for both at 10:00, and a 60-minute booking at 09:00 did not stop another at 09:30.
--
-- FORWARD
--  0. PRE-FLIGHT, read-only. If any two live bookings of one business already overlap,
--     or a booking has no length, the migration stops with the list of booking ids and
--     changes NOTHING. It never cancels or moves a booking: a person settles each pair
--     with the business and the customer, then the deploy runs again.
--  1. bookings."vendorId" (the business, back-filled from the listing), "tenantId"
--     (the business's tenant) and "exclusive" (made while the business took one booking
--     at a time: every existing booking, since every business starts at capacity 1);
--     vendors."bookingCapacity" (how many at once, default 1). Prisma-shaped indexes and
--     foreign keys.
--  2. The business's time, held by the database (src/modules/booking/one-at-a-time.ts
--     bookingResourceDdl(), byte for byte): btree_gist; the per-listing unique retired;
--     a booking lasts some time; the one-at-a-time exclusion over
--     ("vendorId", tsrange("slotStart", "slotEnd")) for live exclusive rows; capacity
--     1..20; the business on a booking is its listing's own.
--  3. The tenant wall: RLS ENABLED and FORCED with the canonical policy
--     (rlsDdlFor('bookings'), byte for byte).
--  4. Tenant lineage: a booking's tenant is its business's (the bookings rule of
--     tenantLineageDdl(), byte for byte; the items shape).
--
-- ROLLBACK: rollback.sql beside this file (forward repair is preferred). Roll the
-- application back first: the previous application writes bookings without a business.

SET lock_timeout = '10s';

-- 0. Pre-flight: refuse loudly, release nothing.
DO $preflight$
DECLARE
  empty_count integer;
  empty_ids text;
  pair_count integer;
  pair_ids text;
BEGIN
  SELECT count(*), string_agg(b.id, ', ' ORDER BY b.id)
    INTO empty_count, empty_ids
    FROM "bookings" b
   WHERE b."slotEnd" <= b."slotStart";
  IF empty_count > 0 THEN
    RAISE EXCEPTION 'BOOKING_EMPTY_RANGE: % booking(s) end at or before they start; nothing was changed. Bookings: %', empty_count, empty_ids;
  END IF;
  WITH live AS (
    SELECT b.id, i."vendorId", b."slotStart", b."slotEnd"
      FROM "bookings" b JOIN "items" i ON i.id = b."itemId"
     WHERE b."status" <> 'CANCELLED'
  )
  SELECT count(*), string_agg(a.id || ' & ' || c.id, ', ' ORDER BY a."slotStart", a.id, c.id)
    INTO pair_count, pair_ids
    FROM live a JOIN live c
      ON c."vendorId" = a."vendorId" AND a.id < c.id
     AND a."slotStart" < c."slotEnd" AND c."slotStart" < a."slotEnd";
  IF pair_count > 0 THEN
    RAISE EXCEPTION 'BOOKING_OVERLAPS_EXIST: % pair(s) of live bookings of one business overlap; nothing was changed and no booking was released. Settle each pair with the business and the customer (cancel or move one), then deploy again. Pairs: %', pair_count, pair_ids;
  END IF;
END $preflight$;

-- 1. The columns (Prisma-shaped), back-filled.
ALTER TABLE "bookings" ADD COLUMN     "exclusive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
ADD COLUMN     "vendorId" TEXT;

UPDATE "bookings" b SET "vendorId" = i."vendorId" FROM "items" i WHERE i.id = b."itemId";
UPDATE "bookings" b SET "tenantId" = v."tenantId" FROM "vendors" v WHERE v.id = b."vendorId" AND b."tenantId" <> v."tenantId";

ALTER TABLE "bookings" ALTER COLUMN "vendorId" SET NOT NULL;

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "bookingCapacity" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "bookings_vendorId_slotStart_idx" ON "bookings"("vendorId", "slotStart");

-- CreateIndex
CREATE INDEX "bookings_tenantId_idx" ON "bookings"("tenantId");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. The business's time, held by the database (bookingResourceDdl()).
CREATE EXTENSION IF NOT EXISTS btree_gist;
DROP INDEX IF EXISTS "bookings_item_slot_live_key";
DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_slot_range_check') THEN
        ALTER TABLE "bookings" ADD CONSTRAINT "bookings_slot_range_check" CHECK ("slotEnd" > "slotStart");
      END IF;
    END $$;
DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_vendor_one_at_a_time') THEN
        ALTER TABLE "bookings" ADD CONSTRAINT "bookings_vendor_one_at_a_time"
          EXCLUDE USING gist ("vendorId" WITH =, tsrange("slotStart", "slotEnd") WITH &&)
          WHERE ("status" <> 'CANCELLED' AND "exclusive");
      END IF;
    END $$;
DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_booking_capacity_check') THEN
        ALTER TABLE "vendors" ADD CONSTRAINT "vendors_booking_capacity_check" CHECK ("bookingCapacity" BETWEEN 1 AND 20);
      END IF;
    END $$;
CREATE OR REPLACE FUNCTION bookings_vendor_matches_item() RETURNS trigger AS $$
      DECLARE listing_vendor TEXT;
      BEGIN
        SELECT "vendorId" FROM items WHERE id = NEW."itemId" INTO listing_vendor;
        IF listing_vendor IS NULL THEN
          RAISE EXCEPTION 'bookings row % names items row %, which does not exist or is not visible from this tenant [BOOK-S1]',
            NEW.id, NEW."itemId" USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."vendorId" IS DISTINCT FROM listing_vendor THEN
          RAISE EXCEPTION 'bookings row % names business % but its listing % belongs to business % [BOOK-S1]',
            NEW.id, NEW."vendorId", NEW."itemId", listing_vendor USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bookings_vendor_matches_item' AND tgrelid = 'bookings'::regclass) THEN
        CREATE TRIGGER bookings_vendor_matches_item BEFORE INSERT OR UPDATE OF "vendorId", "itemId" ON bookings FOR EACH ROW EXECUTE FUNCTION bookings_vendor_matches_item();
      END IF;
    END $$;

-- 3. The tenant wall (rlsDdlFor('bookings')).
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bookings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "bookings";
CREATE POLICY "tenant_isolation" ON "bookings"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- 4. Tenant lineage (tenantLineageDdl(), the bookings rule).
CREATE OR REPLACE FUNCTION bookings_tenant_matches_vendor() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM vendors WHERE id = NEW."vendorId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'bookings row % names vendors row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."vendorId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'bookings row % names tenant % but its vendors row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."vendorId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS bookings_tenant_matches_vendor ON bookings;
CREATE TRIGGER bookings_tenant_matches_vendor BEFORE INSERT OR UPDATE OF "tenantId", "vendorId" ON bookings FOR EACH ROW EXECUTE FUNCTION bookings_tenant_matches_vendor();
