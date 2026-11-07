-- ROLLBACK for 20261029042000_chain_brand (one brand card per chain, owner 29 Oct 2026).
-- Roll the application back first. Nothing is lost that customers rely on: without the columns every branch is listed
-- on its own card, as before. The brand names Swift set are dropped with the column (they are in the admin audit trail).
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "vendors" DROP COLUMN "brandListedAlone";
ALTER TABLE "vendor_owners" DROP CONSTRAINT "vendor_owners_brand_name_shape";
ALTER TABLE "vendor_owners" DROP COLUMN "brandName";
DO $ledger$
DECLARE n integer;
BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029042000_chain_brand';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
