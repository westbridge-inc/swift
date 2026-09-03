-- [A-12] A subscription top-up records money that arrived from a real bank or
-- MMG transfer. The Idempotency-Key already made the same REQUEST safe to
-- repeat, but it is a client retry token scoped to one admin: it says nothing
-- about the same TRANSFER being credited twice under a fresh key, or by a
-- second operator working from the same statement.
--
-- `providerRef` is that identity, and it is UNIQUE: one transfer credits one
-- subscription, once.
--
-- A NEW column rather than a unique index on the existing `reference`: that
-- field has been free-text and optional since it shipped, so constraining it
-- would refuse this migration on any deployment where two notes happen to
-- match — a blocked deploy for a historic typo. Existing rows carry NULL here
-- and do not collide; the API has required a reference since this shipped.
ALTER TABLE "topup_commands" ADD COLUMN "providerRef" TEXT;
CREATE UNIQUE INDEX "topup_commands_providerRef_key" ON "topup_commands"("providerRef");
