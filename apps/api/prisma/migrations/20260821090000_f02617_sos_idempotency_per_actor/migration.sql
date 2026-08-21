-- [F-026-17] SOS idempotency is scoped to the ACTOR, not the whole platform.
--
-- The old global unique on "clientIdempotencyKey" made one person's emergency
-- addressable by any authenticated caller who could guess or reuse the string:
--   * a second user posting the same key was handed the FIRST user's alert id
--     and status, and their own alert was never raised; and
--   * a key claimed first (e.g. the server-derived "guardian:<sessionId>")
--     silently suppressed the real owner's later escalation.
--
-- The composite is strictly weaker than the index it replaces, so no existing
-- row can violate it and this migration cannot fail on live data.
DROP INDEX IF EXISTS "SosAlert_clientIdempotencyKey_key";

CREATE UNIQUE INDEX "SosAlert_actorUserId_clientIdempotencyKey_key"
  ON "SosAlert" ("actorUserId", "clientIdempotencyKey");
