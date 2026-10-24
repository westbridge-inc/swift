-- [MMG checkout · 7 Oct] MMG's Transaction History answer for a payment is
-- written down, like every reply and lookup, before anything is decided on it:
-- a new observation source, HISTORY. MMG said (7 Oct) that its lookup's
-- creationDate is the moment of the lookup and that history's modificationDate
-- is when the payment was made, so the payment's time now comes from history.
-- Only widens the allowed sources: no column, no change to any row, and nothing
-- here moves or credits money. Every existing row already satisfies it.
-- Rollback: rollback.sql restores the old list for NEW rows only (NOT VALID),
-- keeping every HISTORY record already written: they are payment evidence.
SET lock_timeout = '10s';

ALTER TABLE "mmg_checkout_observations"
  DROP CONSTRAINT "mmg_checkout_observations_source_check",
  ADD CONSTRAINT "mmg_checkout_observations_source_check" CHECK ("source" IN ('RETURN', 'NOTIFY', 'LOOKUP', 'HISTORY'));
