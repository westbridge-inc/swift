-- Rollback of 20261019100010_audit_logs_erasure_cutoff_index: drops only the partial index (online).
DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_erasure_cutoff_idx";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261019100010_audit_logs_erasure_cutoff_index';
