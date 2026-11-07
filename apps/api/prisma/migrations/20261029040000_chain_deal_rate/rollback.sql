-- ROLLBACK for 20261029040000_chain_deal_rate (chain deals, owner 29 Oct 2026).
--
-- Forward repair is preferred. Roll the application back first: the previous application never reads these columns.
-- The guard refuses while any owner holds a deal: the record of who set it, when and why would be lost.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "vendor_owners" WHERE "dealWeeklyRate" IS NOT NULL) THEN
    RAISE EXCEPTION 'CHAIN_DEALS_IN_USE: an owner holds a chain deal; not rolling back';
  END IF;
END $guard$;
ALTER TABLE "vendor_owners" DROP CONSTRAINT "vendor_owners_deal_stated";
ALTER TABLE "vendor_owners" DROP CONSTRAINT "vendor_owners_deal_whole_positive";
ALTER TABLE "vendor_owners"
  DROP COLUMN "dealReason",
  DROP COLUMN "dealSetBy",
  DROP COLUMN "dealSetAt",
  DROP COLUMN "dealCurrencyCode",
  DROP COLUMN "dealWeeklyRate";
DO $ledger$
DECLARE n integer;
BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029040000_chain_deal_rate';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
