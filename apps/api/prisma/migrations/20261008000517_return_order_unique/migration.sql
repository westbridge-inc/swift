-- One return per order is already the API contract. Refuse to migrate if
-- historical duplicates need review; report counts only and preserve rows.
BEGIN;
DO $$
DECLARE duplicate_order_groups bigint;
BEGIN
  SELECT count(*) INTO duplicate_order_groups
  FROM (
    SELECT "orderId" FROM return_requests
    GROUP BY "orderId" HAVING count(*) > 1
  ) duplicates;
  IF duplicate_order_groups > 0 THEN
    RAISE EXCEPTION 'Return uniqueness migration held: % duplicate order groups require review', duplicate_order_groups;
  END IF;
END $$;

CREATE UNIQUE INDEX "return_requests_orderId_key" ON "return_requests"("orderId");
DROP INDEX "return_requests_orderId_idx";
COMMIT;
