-- Rollback of 20261021140000_offsite_erasure_ledger. Stop the host unit first
-- (sudo systemctl disable --now swift-erasure-ledger.timer). Dropping the ledger
-- loses the off-site record of erasures not yet shipped: ship them first
-- (deploy/erasure-ledger-ship.sh --project swift until it says nothing to ship).
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP TRIGGER IF EXISTS erasure_ledger_receipts ON deletion_receipt;
DROP TRIGGER IF EXISTS erasure_ledger_destroyed_keys ON encrypted_objects;
DROP TRIGGER IF EXISTS erasure_ledger_retired_documents ON verification_documents;
DROP TRIGGER IF EXISTS erasure_ledger_shredded_runs ON extraction_run;
DROP TRIGGER IF EXISTS erasure_ledger_shredded_fields ON extracted_field;
DROP TRIGGER IF EXISTS erasure_ledger_closed_accounts ON users;
DROP TRIGGER IF EXISTS erasure_ledger_erased_rating_text ON ratings;
DROP TRIGGER IF EXISTS erasure_ledger_erased_outbox_text ON rating_outbox;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON sessions;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON device_tokens;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON verification_decision_outbox;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON advertiser_members;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON vendor_staff;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON face_templates;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON identity_keys;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON identity_cluster_members;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON addresses;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON account_recoveries;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON "LivenessCheck";
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON trip_share_tokens;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON "EmergencyContact";
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON ride_queue_entries;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON supply_watches;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON carts;
DROP TRIGGER IF EXISTS erasure_ledger_deleted_row ON cart_merge_receipts;
DROP TABLE IF EXISTS erasure_ledger_shipment;
DROP TABLE IF EXISTS erasure_ledger_entry;
DROP FUNCTION IF EXISTS erasure_ledger_capture();
DROP FUNCTION IF EXISTS erasure_ledger_capture_closed_row();
DROP FUNCTION IF EXISTS erasure_ledger_capture_closed_account();
DROP FUNCTION IF EXISTS erasure_ledger_kept_rows(text);
DROP FUNCTION IF EXISTS erasure_ledger_append_only();
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261021140000_offsite_erasure_ledger';
COMMIT;
