-- Rollback for 20261024060000_store_vat: drops the store-VAT columns and their enum types.
-- Lost: stores' VAT choices and approvals, items' VAT classes, and the VAT frozen on orders placed while it
-- was live (their totals are untouched: VAT was always inside the price). Nothing else reads these columns.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "vatClass";
ALTER TABLE "orders"
  DROP COLUMN IF EXISTS "vatAmount",
  DROP COLUMN IF EXISTS "vatRateBps",
  DROP COLUMN IF EXISTS "vatStandardGoods",
  DROP COLUMN IF EXISTS "vatZeroRatedGoods",
  DROP COLUMN IF EXISTS "vatExemptGoods",
  DROP COLUMN IF EXISTS "vatBase",
  DROP COLUMN IF EXISTS "vatSellerNumber",
  DROP COLUMN IF EXISTS "vatSellerName";
ALTER TABLE "items" DROP COLUMN IF EXISTS "vatClass";
ALTER TABLE "vendors"
  DROP COLUMN IF EXISTS "vatStatus",
  DROP COLUMN IF EXISTS "vatMode",
  DROP COLUMN IF EXISTS "vatCertificateDocId",
  DROP COLUMN IF EXISTS "vatApprovedNumber",
  DROP COLUMN IF EXISTS "vatApprovedName",
  DROP COLUMN IF EXISTS "vatEffectiveFrom",
  DROP COLUMN IF EXISTS "vatReviewedBy",
  DROP COLUMN IF EXISTS "vatReviewedAt",
  DROP COLUMN IF EXISTS "vatReviewNote";
DROP TYPE IF EXISTS "StoreVatMode";
DROP TYPE IF EXISTS "StoreVatStatus";
DROP TYPE IF EXISTS "VatClass";
COMMIT;
