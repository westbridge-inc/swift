// ---------------------------------------------------------------------------
// [BOOK-S1] ONE PROVIDER, ONE TIME — the database's half.
//
// A booking takes the BUSINESS's time (bookings."vendorId"), whichever listing
// it was made on. The application refuses an overlap under an advisory lock per
// business (BookingService); for a business that takes one booking at a time
// (capacity 1, the default) the database refuses it too, so a write that skips
// the service cannot double-book anyone:
//
//   bookings_vendor_one_at_a_time   EXCLUDE USING gist ("vendorId" WITH =,
//                                   tsrange("slotStart", "slotEnd") WITH &&)
//                                   for live rows made under capacity 1.
//   bookings_slot_range_check       a booking lasts some time (an empty range
//                                   would never overlap anything).
//   bookings_vendor_matches_item    the business on the row is the listing's own.
//   vendors_booking_capacity_check  1..MAX_BOOKING_CAPACITY at once.
//
// The slot columns are timestamp(3) holding UTC instants, so the range is a
// tsrange: a tstzrange over them would need a timezone-dependent cast, which an
// index may not use. Ranges are [start, end): back to back is not an overlap.
//
// The per-listing partial unique (bookings_item_slot_live_key) is retired: for a
// one-at-a-time business the exclusion covers it (same listing, same start is
// an overlap), and for a business that serves several at once it would refuse
// the second chair.
//
// Every statement is idempotent. Migration 20261028120000_booking_one_provider_one_time
// carries this text byte for byte (booking-one-at-a-time-migration.test.ts), and
// the test installer heals a db-push database with the same statements.
// ---------------------------------------------------------------------------

export const BOOKING_EXCLUSION = 'bookings_vendor_one_at_a_time';
export const BOOKING_RANGE_CHECK = 'bookings_slot_range_check';
export const BOOKING_VENDOR_TRIGGER = 'bookings_vendor_matches_item';
export const VENDOR_CAPACITY_CHECK = 'vendors_booking_capacity_check';
export const RETIRED_ITEM_SLOT_KEY = 'bookings_item_slot_live_key';
/** The most appointments one business may serve at once. */
export const MAX_BOOKING_CAPACITY = 20;

export function bookingResourceDdl(): string[] {
  return [
    `CREATE EXTENSION IF NOT EXISTS btree_gist`,
    `DROP INDEX IF EXISTS "${RETIRED_ITEM_SLOT_KEY}"`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${BOOKING_RANGE_CHECK}') THEN
        ALTER TABLE "bookings" ADD CONSTRAINT "${BOOKING_RANGE_CHECK}" CHECK ("slotEnd" > "slotStart");
      END IF;
    END $$`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${BOOKING_EXCLUSION}') THEN
        ALTER TABLE "bookings" ADD CONSTRAINT "${BOOKING_EXCLUSION}"
          EXCLUDE USING gist ("vendorId" WITH =, tsrange("slotStart", "slotEnd") WITH &&)
          WHERE ("status" <> 'CANCELLED' AND "exclusive");
      END IF;
    END $$`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${VENDOR_CAPACITY_CHECK}') THEN
        ALTER TABLE "vendors" ADD CONSTRAINT "${VENDOR_CAPACITY_CHECK}" CHECK ("bookingCapacity" BETWEEN 1 AND ${MAX_BOOKING_CAPACITY});
      END IF;
    END $$`,
    `CREATE OR REPLACE FUNCTION ${BOOKING_VENDOR_TRIGGER}() RETURNS trigger AS $$
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
      END $$ LANGUAGE plpgsql`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${BOOKING_VENDOR_TRIGGER}' AND tgrelid = 'bookings'::regclass) THEN
        CREATE TRIGGER ${BOOKING_VENDOR_TRIGGER} BEFORE INSERT OR UPDATE OF "vendorId", "itemId" ON bookings FOR EACH ROW EXECUTE FUNCTION ${BOOKING_VENDOR_TRIGGER}();
      END IF;
    END $$`,
  ];
}

/** Did a write lose to the one-at-a-time exclusion (SQLSTATE 23P01)? Prisma has
 *  no known-request code for an exclusion violation, so it is read from the
 *  driver's code or the constraint's name in the message. */
export function isBookingExclusionViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; meta?: { code?: unknown } | null; message?: unknown };
  if (e.code === '23P01' || e.meta?.code === '23P01') return true;
  return typeof e.message === 'string' && (e.message.includes(BOOKING_EXCLUSION) || /\b23P01\b/.test(e.message));
}
