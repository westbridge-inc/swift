-- [CHAINS · COORD ruling 29 Oct 2026] A branch never goes live on its owner's documents alone: a person at Swift
-- approves it (its address and pin) first. EXPAND only: one boolean on vendors, false for every existing store (each
-- was made through sign-up and is projected exactly as before); only POST /vendor/stores sets it true.
--
-- FORWARD
--  1. vendors."personApprovalRequired" BOOLEAN NOT NULL DEFAULT false (a constant default: no table rewrite).
--
-- ROLLBACK: rollback.sql beside this file. Roll the application back first. The guard refuses while any store is still
-- waiting for a person (dropping the column would let the daily projection put it live on the owner's documents alone).

SET lock_timeout = '10s';

ALTER TABLE "vendors" ADD COLUMN "personApprovalRequired" BOOLEAN NOT NULL DEFAULT false;
