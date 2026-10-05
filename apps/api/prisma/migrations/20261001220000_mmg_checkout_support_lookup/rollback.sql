-- [MMG support lookup] Undo 20261001220000_mmg_checkout_support_lookup. Indexes
-- hold no data: dropping them loses only the speed of an exact support search,
-- never a record. Safe on an empty or a populated database.
BEGIN;
DROP INDEX IF EXISTS "mmg_checkout_observations_lookup_reference_idx";
DROP INDEX IF EXISTS "mmg_checkout_intents_candidates_idx";
COMMIT;
