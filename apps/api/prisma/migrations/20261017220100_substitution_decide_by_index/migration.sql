-- [SUBSTITUTION · owner 17 Oct 2026] The once-a-minute swap-deadline sweep
-- reads only OPEN swap questions. A partial index keeps that read tiny however
-- large order_items grows (open questions are a handful at any moment).
--
-- Built ONLINE on an existing, busy table. Keep this file to exactly one
-- PostgreSQL statement: Prisma submits a multi-statement migration as an
-- implicit transaction, where CREATE INDEX CONCURRENTLY is forbidden (the
-- precedent is 20260925000410 and 20260808020000). A build that is interrupted
-- leaves an INVALID index behind: drop it, then rerun this migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_items_open_substitution_decide_by_idx"
ON "order_items"("substituteDecideBy") WHERE "subStatus" = 'PENDING';
