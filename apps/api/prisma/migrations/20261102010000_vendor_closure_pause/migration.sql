-- [WEB-DELETE · owner ruling 1 Nov 2026] A store owner's account closure request pauses the store's NEW orders at once
-- (the website and the app share the one closure path, user/account.service.ts closureTicket). Orders already placed
-- still finish; Swift's team then completes the closure. Only Swift staff resolving the request, or the owner
-- cancelling it, lifts the pause.
-- EXPAND only: one nullable column on vendors, and a CHECK that keeps order intake off while it is set, so no writer
-- (the owner's switch, a billing reinstatement, an activation) can reopen a store the request paused.
--
-- FORWARD
--  1. vendors."closurePausedAt": set with acceptingOrders = false by the closure request; cleared by the lift.
--  2. vendors_closure_pause_keeps_intake_off: acceptingOrders cannot be true while closurePausedAt is set. Every
--     existing row has it NULL, so the check holds at once.
--
-- ROLLBACK: rollback.sql beside this file (drops both; roll the application back first).
-- [REVIEW-M #2046 S4] vendors is a hot table: wait at most 10 s for a lock, then fail (retry) instead of queueing.
SET lock_timeout = '10s';

ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "closurePausedAt" TIMESTAMP(3);

ALTER TABLE "vendors" DROP CONSTRAINT IF EXISTS "vendors_closure_pause_keeps_intake_off";
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_closure_pause_keeps_intake_off"
  CHECK ("closurePausedAt" IS NULL OR "acceptingOrders" = false);
