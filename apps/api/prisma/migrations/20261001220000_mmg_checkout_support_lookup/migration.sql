-- [MMG support lookup] Support finds an MMG weekly-fee payment by any id MMG or
-- Swift gave it, as an EXACT match on an index. Additive: two indexes, no
-- column, no change to any row. Nothing here moves or credits money.
--   1. A transaction a reply named: candidates @> ARRAY[id] (GIN, declared in
--      schema.prisma as @@index([candidates], type: Gin)).
--   2. The MMG ledger number (transactionReference) a lookup returned: an
--      expression index over the LOOKUP observations only. Prisma cannot
--      express an expression or partial index, so it lives here alone.
-- Rollback: rollback.sql drops both; indexes hold no data.
SET lock_timeout = '10s';

CREATE INDEX "mmg_checkout_intents_candidates_idx" ON "mmg_checkout_intents" USING GIN ("candidates");

CREATE INDEX "mmg_checkout_observations_lookup_reference_idx"
  ON "mmg_checkout_observations" (("body" ->> 'transactionReference'))
  WHERE "source" = 'LOOKUP';
