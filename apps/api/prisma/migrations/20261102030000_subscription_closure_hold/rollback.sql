-- [WEB-DELETE] Rollback of 20261102030000_subscription_closure_hold: roll the application back first (it writes these).
SET lock_timeout = '10s';
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "closureHoldTicketId";
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "closureHoldAt";
