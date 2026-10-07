-- [L02 · row 34] The cash taken at the door, as the mover stated it.
--
-- The rider's "paid" used to mean "the full amount was collected"; nothing
-- recorded how much cash actually changed hands. Owner ruling (5 Oct 2026):
-- no handover without full cash; a mover who hands over for less anyway bears
-- the difference, and the mismatch is recorded, held for a person and paged.
--
--   doorCashCollectedAmount  the cash the mover stated they took (whole units)
--   doorCashShortfallAmount  how far short of the total a handover was made
--   doorCashMismatchAt       the short handover is held for review from here
--
-- ADDITIVE AND INERT. Three nullable columns with no default: a catalogue-only
-- change on PostgreSQL 11+ (no table rewrite). Every existing order reads NULL
-- ("not stated"), which is exactly what an older app keeps writing, so the
-- store build in review behaves as before.
--
-- The CHECKs hold the columns to what the handover writes: whole, non-negative
-- amounts; a shortfall is positive and only exists beside a stated collected
-- amount (collected + shortfall = the order total at the time, enforced in
-- code on the locked row); a held mismatch always carries its shortfall and
-- a shortfall is always held.
-- They are added NOT VALID and validated separately, so the validation scan
-- takes only a SHARE UPDATE EXCLUSIVE lock on "orders".
--
-- ROLLBACK: rollback.sql in this directory (roll the application back first).
SET lock_timeout = '10s';
ALTER TABLE "orders" ADD COLUMN "doorCashCollectedAmount" DECIMAL(12,2);
ALTER TABLE "orders" ADD COLUMN "doorCashShortfallAmount" DECIMAL(12,2);
ALTER TABLE "orders" ADD COLUMN "doorCashMismatchAt" TIMESTAMP(3);

ALTER TABLE "orders" ADD CONSTRAINT "orders_door_cash_collected_whole"
  CHECK ("doorCashCollectedAmount" IS NULL OR ("doorCashCollectedAmount" >= 0 AND "doorCashCollectedAmount" = trunc("doorCashCollectedAmount"))) NOT VALID;
ALTER TABLE "orders" ADD CONSTRAINT "orders_door_cash_shortfall_whole_positive"
  CHECK ("doorCashShortfallAmount" IS NULL OR ("doorCashShortfallAmount" > 0 AND "doorCashShortfallAmount" = trunc("doorCashShortfallAmount"))) NOT VALID;
ALTER TABLE "orders" ADD CONSTRAINT "orders_door_cash_mismatch_carries_shortfall"
  CHECK (("doorCashShortfallAmount" IS NULL) = ("doorCashMismatchAt" IS NULL)
     AND ("doorCashShortfallAmount" IS NULL OR "doorCashCollectedAmount" IS NOT NULL)) NOT VALID;

ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_door_cash_collected_whole";
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_door_cash_shortfall_whole_positive";
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_door_cash_mismatch_carries_shortfall";
