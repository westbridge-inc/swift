-- [row 267 · AUD-L4-021] The three durable outboxes stop retrying forever.
--
-- order_outbox (the publisher rows), mover_revocation_outbox and rating_outbox
-- retried a failing row with backoff for ever (the rating outbox stopped at 25
-- attempts, silently). Each row now carries its retry budget ("maxAttempts")
-- and, once spent, its dead-letter stamp ("deadLetteredAt"): the drains never
-- claim an exhausted row again, the scheduler sweep stamps it, the dead-letter
-- alarm pages it (ops_dlq_non_empty), and the admin Background jobs page lists
-- it until an operator requeues it (attempts back to 0). Nothing is deleted.
--
-- Existing rows take the defaults. A rating row already at 25 attempts (given
-- up silently before this) becomes a dead letter on the first sweep, and pages:
-- that is the point. Rollback: rollback.sql beside this file.
ALTER TABLE "order_outbox"
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3);
ALTER TABLE "mover_revocation_outbox"
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3);
ALTER TABLE "rating_outbox"
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3);
