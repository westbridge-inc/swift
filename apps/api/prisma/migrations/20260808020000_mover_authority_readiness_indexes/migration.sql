-- Expand-only support for the bounded mover-authority proof. Keep this file to
-- exactly one PostgreSQL statement: Prisma submits a multi-statement migration
-- as an implicit transaction, where CREATE INDEX CONCURRENTLY is forbidden.
-- The remaining online indexes each have their own independently ledgered
-- single-statement migration before the non-rolling cutover.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "riders_currentOrderId_idx"
ON "riders"("currentOrderId");
