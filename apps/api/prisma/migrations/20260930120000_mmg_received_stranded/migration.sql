-- [MMG-RECV] Agent-cash payments stranded RECEIVED.
--
-- An observation is saved RECEIVED first and judged after. When the delivery
-- that saved it dies in between, it stays RECEIVED; every redelivery answers
-- `duplicate`, and nothing ever looked at RECEIVED again: money on disk, never
-- credited. A redelivery and the poll-mmg-billing repair pass now finish it.
--
-- 1. "createdAt" is stamped by the INSERT itself, on the database clock in UTC
--    (the timestamp(3) columns hold UTC, as Prisma writes them). Before, the
--    Prisma engine sent the app server's clock. The age of a RECEIVED
--    observation decides whether it is stranded, so it must not depend on an
--    app server clock. clock_timestamp(), not now(): inside a transaction now()
--    is the time the transaction began.
-- 2. "finishAttemptAt": when the repair pass last tried and failed to finish
--    the observation (database clock). The pass takes the least recently
--    tried first and leaves a failed one alone for a backoff, so observations
--    that fail every time cannot starve the rest.
--
-- Metadata only: a nullable column and a new column default, no rewrite, no
-- backfill. Existing rows keep their createdAt.
--
-- [AX363-F3] The ALTER still needs an ACCESS EXCLUSIVE lock on a live payments
-- table. Waiting for it behind a long or idle transaction would queue every
-- payment INSERT and credit UPDATE behind this migration, so the wait is
-- bounded here (set in THIS migration, never inherited from an earlier one):
-- under contention the deploy fails fast and is retried once it clears.
SET lock_timeout = '10s';

-- AlterTable
ALTER TABLE "mmg_agent_payments" ADD COLUMN     "finishAttemptAt" TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DEFAULT timezone('UTC'::text, clock_timestamp());
