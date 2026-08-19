-- Expand phase only: one authoritative device session owns each mover location
-- stream. The columns are nullable so the schema can be added without rewriting
-- the tables, but mixed old/new application binaries are NOT authority-safe:
-- an old binary does not predicate writes on this generation. Production must
-- use the drained cutover enforced by 20260808021500 and its release runbook.
ALTER TABLE "riders" ADD COLUMN "locationSessionId" TEXT;
ALTER TABLE "drivers" ADD COLUMN "locationSessionId" TEXT;
