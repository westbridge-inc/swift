-- ROLLBACK for 20261028120000_booking_one_provider_one_time (one provider, one time).
--
-- Forward repair is preferred. Roll the application back first: the previous
-- application writes bookings without a business and knows no capacity. The
-- business and tenant columns are derived from the listing, so dropping them
-- loses nothing. The guard refuses when rolling back WOULD lose something:
--  - a business that set "how many at once" above 1 would lose that setting;
--  - two live bookings that share a listing and a start (several chairs) would
--    make the per-listing unique impossible to bring back.
-- No booking is cancelled or moved by this file.
BEGIN;
-- Row-level security is FORCED on bookings: without this, a role that does not
-- bypass it sees no rows, the guard passes blind, and a setting is dropped.
-- With it, such a role gets an error instead.
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "vendors" WHERE "bookingCapacity" <> 1) THEN
    RAISE EXCEPTION 'BOOKING_CAPACITY_IN_USE: a business serves several appointments at once; rolling back would erase that setting. Not rolling back';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "bookings" a JOIN "bookings" c
      ON c."itemId" = a."itemId" AND c."slotStart" = a."slotStart" AND a.id < c.id
     WHERE a."status" <> 'CANCELLED' AND c."status" <> 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'BOOKING_SHARED_SLOTS: two live bookings share a listing and a start; the per-listing unique cannot come back. Not rolling back';
  END IF;
END $guard$;
DROP TRIGGER bookings_tenant_matches_vendor ON "bookings";
DROP FUNCTION bookings_tenant_matches_vendor();
DROP TRIGGER bookings_vendor_matches_item ON "bookings";
DROP FUNCTION bookings_vendor_matches_item();
DROP POLICY "tenant_isolation" ON "bookings";
ALTER TABLE "bookings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "bookings" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_vendor_one_at_a_time";
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_slot_range_check";
ALTER TABLE "vendors" DROP CONSTRAINT "vendors_booking_capacity_check";
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_vendorId_fkey";
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_tenantId_fkey";
DROP INDEX "bookings_vendorId_slotStart_idx";
DROP INDEX "bookings_tenantId_idx";
ALTER TABLE "bookings" DROP COLUMN "exclusive", DROP COLUMN "tenantId", DROP COLUMN "vendorId";
ALTER TABLE "vendors" DROP COLUMN "bookingCapacity";
-- The per-listing unique, exactly as 20260612001006_step6_bookings made it.
CREATE UNIQUE INDEX "bookings_item_slot_live_key" ON "bookings"("itemId", "slotStart") WHERE "status" <> 'CANCELLED';
-- btree_gist stays installed: an extension is shared database state, and an unused one is inert.
DO $ledger$
DECLARE n integer;
BEGIN
  -- The applied row only: a failed attempt that was marked rolled back (prisma migrate resolve) stays as history.
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261028120000_booking_one_provider_one_time' AND "rolled_back_at" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
