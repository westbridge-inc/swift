-- Restore the previous lookup index without altering return records.
BEGIN;
CREATE INDEX "return_requests_orderId_idx" ON "return_requests"("orderId");
DROP INDEX "return_requests_orderId_key";
COMMIT;
