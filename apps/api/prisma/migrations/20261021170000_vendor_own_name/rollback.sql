-- Rollback for 20261021170000_vendor_own_name: the stores lose the own-name basis and ask for a business
-- registration again (deploy the code that no longer reads the column first).
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "tradesUnderOwnName";
