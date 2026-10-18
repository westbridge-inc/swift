-- Rollback for 20261015180000_vendor_refund_rule: drops the store's refund rule column.
-- Any refund rules stores typed are lost; their storefronts go back to "Ask the store".
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "refundRule";
COMMIT;
