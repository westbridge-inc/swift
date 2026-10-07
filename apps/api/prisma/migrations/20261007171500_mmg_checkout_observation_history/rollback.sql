-- [MMG checkout · 7 Oct] Undo 20261007171500_mmg_checkout_observation_history.
-- New observations may again be only RETURN, NOTIFY or LOOKUP. HISTORY records
-- already written are payment evidence (a payment may be confirming, held or
-- credited against them) and are never deleted: the old constraint comes back
-- NOT VALID, so it binds new rows and leaves those in place. Roll the code back
-- first, or verify() fails to write its history record and confirms nothing.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "mmg_checkout_observations"
  DROP CONSTRAINT "mmg_checkout_observations_source_check",
  ADD CONSTRAINT "mmg_checkout_observations_source_check" CHECK ("source" IN ('RETURN', 'NOTIFY', 'LOOKUP')) NOT VALID;
COMMIT;
