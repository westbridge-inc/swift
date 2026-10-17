-- [R3 · CAA s.70(3) · legal research D10 + E5 · owner 15 Oct 2026] A storefront shows how payment works and the
-- store's refund rule. The refund rule is the store's own words, typed by its owner; until one is given the
-- storefront says "Ask the store" (never an invented rule).
--
-- ADDITIVE ONLY: one nullable column. Every existing row keeps NULL — no refund rule on file.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "vendors" ADD COLUMN "refundRule" TEXT;
