-- ROLLBACK for 20261029071000_chain_deal_change (chain deal end / raise, ENTERPRISE E2, 29 Oct 2026).
--
-- Forward repair is preferred. Roll the application back first: the previous application never reads these columns.
-- The guard refuses while any owner has a change pending: the branches' told fee rises (platform_config
-- billing.fee_rise:<subscription>, source CHAIN_DEAL) name it, and the previous application cannot apply them.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "vendor_owners" WHERE "dealChangeKind" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "platform_config" WHERE "key" LIKE 'billing.fee_rise:%' AND "value"->>'source' = 'CHAIN_DEAL') THEN
    RAISE EXCEPTION 'CHAIN_DEAL_CHANGES_IN_USE: a chain deal change or its fee rise is pending; not rolling back';
  END IF;
END $guard$;
ALTER TABLE "vendor_owners" DROP CONSTRAINT "vendor_owners_deal_change_stated";
ALTER TABLE "vendor_owners"
  DROP COLUMN "dealChangeSwitchedAt",
  DROP COLUMN "dealChangeSetAt",
  DROP COLUMN "dealChangeSetBy",
  DROP COLUMN "dealChangeReason",
  DROP COLUMN "dealChangeNotBefore",
  DROP COLUMN "dealChangeTo",
  DROP COLUMN "dealChangeFrom",
  DROP COLUMN "dealChangeKind";
DO $ledger$
DECLARE n integer;
BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029071000_chain_deal_change';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
