-- [PT-1 · AX297 F4] The index on the EXISTING subscription_payments table,
-- built ONLINE. A plain CREATE INDEX holds a SHARE lock that blocks every
-- payment write for the whole build (lock_timeout bounds only the wait to
-- acquire it), and every billing rail writes this table. The indexes of the
-- three NEW card tables stay in 20260925000400: those tables are born empty.
--
-- Keep this file to exactly one PostgreSQL statement: Prisma submits a
-- multi-statement migration as an implicit transaction, where CREATE INDEX
-- CONCURRENTLY is forbidden (the precedent is 20260808020000 and its five
-- sibling online-index migrations). A build that is interrupted leaves an
-- INVALID index behind: drop it, then rerun this migration (IF NOT EXISTS on
-- its own would keep the invalid one).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "subscription_payments_instrumentId_idx"
ON "subscription_payments"("instrumentId");
