-- [WEB-DELETE · owner ruling 2 Nov 2026 · REVIEW-M #2304 S2] The weekly fee stops from the moment a store owner asks
-- Swift to close the account, with its own narrow marker. It is never auto-renew: settlement applies a payment to a
-- week already owed only on an auto-renewing plan, so a hold made of auto-renew banked such a payment as credit.
-- billing/closure-fee-hold.ts holds the fee; the billing run, its reminders and its lapse read the marker.
-- EXPAND only: two nullable columns on subscriptions.
--
-- FORWARD
--  1. subscriptions."closureHoldAt": no week that starts at or after it is born, charged or reminded.
--  2. subscriptions."closureHoldTicketId": the closure request (support ticket) that holds it.
--
-- ROLLBACK: rollback.sql beside this file (drops both; roll the application back first).
SET lock_timeout = '10s';

ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "closureHoldAt" TIMESTAMP(3);
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "closureHoldTicketId" TEXT;
