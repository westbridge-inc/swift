-- [erasure exceptions] swift_erased_person reads the erasure's ACCOUNT_ERASURE_CUTOFF audit row by account: a small
-- partial index (only those rows), built online. Its own migration: CONCURRENTLY cannot run inside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_erasure_cutoff_idx" ON "audit_logs"("entityId") WHERE "action" = 'ACCOUNT_ERASURE_CUTOFF' AND "entity" = 'User';
