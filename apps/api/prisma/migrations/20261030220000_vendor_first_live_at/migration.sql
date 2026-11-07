-- [RETIER PR-A · COORD security review on #2245 · owner 30 Oct 2026: existing partners are not moved] The moment a store
-- FIRST went live, kept for good. Only a store that has never been live is priced on its own catalogue when its weekly
-- fee is born, and asked to tick that fee first (partner/store-fee.ts); a store that has been live and comes back
-- without a fee on record keeps the first step. Status cannot tell them apart (a store suspended before it ever went
-- live is SUSPENDED too), and the activation marks (isVerified, activationValidUntil) are cleared when documents lapse.
-- EXPAND only: one nullable column on vendors.
--
-- FORWARD
--  1. vendors."firstLiveAt": set by the activation projection (and the console's reinstate) the first time a store is
--     made live; never cleared.
--  2. Backfill: every store that shows it has been live is marked (its own createdAt stands in for the unknown day):
--     ACTIVE now, verified now, holding a weekly-fee subscription (every go-live since billing began creates one), or
--     with any order. A store with none of these has never been live and stays NULL.
--
-- ROLLBACK: rollback.sql beside this file (drops the column; roll the application back first).

SET lock_timeout = '10s';

ALTER TABLE "vendors" ADD COLUMN "firstLiveAt" TIMESTAMP(3);

UPDATE "vendors" v SET "firstLiveAt" = v."createdAt"
WHERE v."firstLiveAt" IS NULL
  AND (
    v."status" = 'ACTIVE'
    OR v."isVerified" = true
    OR EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."vendorId" = v."id")
    OR EXISTS (SELECT 1 FROM "orders" o WHERE o."vendorId" = v."id")
  );
