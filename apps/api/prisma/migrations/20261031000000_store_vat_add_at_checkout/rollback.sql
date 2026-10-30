-- Rollback for 20261031000000_store_vat_add_at_checkout. Roll the CODE back first (the previous release refuses
-- the ADD_VAT_AT_CHECKOUT mode, so no new order freezes VAT for such a store). Then every price goes back to what
-- the store typed (before VAT), and the columns are dropped. Orders already placed keep what they froze.
BEGIN;
SET LOCAL lock_timeout = '10s';
UPDATE "items" SET "basePrice" = "vatListedPrice", "updatedAt" = now() WHERE "vatListedPrice" IS NOT NULL;
UPDATE "options" SET "additionalPrice" = "vatListedAdditionalPrice" WHERE "vatListedAdditionalPrice" IS NOT NULL;
ALTER TABLE "options" DROP COLUMN IF EXISTS "vatListedAdditionalPrice";
ALTER TABLE "items" DROP COLUMN IF EXISTS "vatListedPrice";
COMMIT;
