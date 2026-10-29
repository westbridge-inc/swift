-- [SUBSTITUTION · owner 17 Oct 2026] A store's swap question waits a bounded
-- time for the customer. This column holds that deadline; past it, the sweep
-- removes the line (the total drops, the customer is told) or, on MMG, where
-- the total can't change in-app, withdraws the question.
--
-- ADDITIVE ONLY: one nullable column, no default (a metadata-only change).
-- Existing rows keep NULL. A swap already open when this ships has NULL here;
-- the sweep gives it a fresh full wait from the moment it first sees it.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "order_items" ADD COLUMN "substituteDecideBy" TIMESTAMP(3);
