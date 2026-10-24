-- [row 264] Rollback of 20261018213000_order_status_transition_guard.
-- Removes exactly the two triggers and two functions the migration made, and its ledger row.
-- No data is touched: the migration wrote no rows and changed no column, so there is nothing
-- to refuse on and nothing to restore. Safe on a populated database (proven on one: see the PR).
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP TRIGGER IF EXISTS orders_status_transition_guard ON "orders";
DROP FUNCTION IF EXISTS orders_status_transition_guard();
DROP TRIGGER IF EXISTS order_status_logs_append_only ON "order_status_logs";
DROP FUNCTION IF EXISTS order_status_logs_append_only();
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261018213000_order_status_transition_guard';
COMMIT;
