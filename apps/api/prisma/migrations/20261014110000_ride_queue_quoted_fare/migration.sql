-- [PRICE-LOCK] The fare a queued passenger was shown (owner: the price shown
-- is the price charged).
--
-- The ride queue (5.5B) books a passenger's ride when a driver frees up, up to
-- RIDE_QUEUE_TTL_MIN later, at the fare of that moment. The passenger never
-- saw that fare. The entry now keeps the fare they were shown when they joined,
-- and the scan books only at it. A fare that moved by then is never charged:
-- the entry ends and the passenger is asked again.
--
-- ADDITIVE AND INERT. One nullable column with no default: every existing
-- entry reads NULL ("joined without a quoted fare") and is booked exactly as
-- before. A nullable column without a default is a catalogue-only change on
-- PostgreSQL 11+ (no table rewrite). The CHECK holds it to a whole,
-- non-negative number of the market's currency, or NULL; queue entries are a
-- short-lived handful of rows, so it is validated in place.
--
-- ROLLBACK: rollback.sql in this directory (roll the application back first).
SET lock_timeout = '10s';
ALTER TABLE "ride_queue_entries" ADD COLUMN "quotedFare" DECIMAL(12,2);
ALTER TABLE "ride_queue_entries" ADD CONSTRAINT "ride_queue_entries_quoted_fare_whole"
  CHECK ("quotedFare" IS NULL OR ("quotedFare" >= 0 AND "quotedFare" = trunc("quotedFare")));
