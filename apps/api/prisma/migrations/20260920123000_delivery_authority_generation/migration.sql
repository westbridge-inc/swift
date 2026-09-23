-- [LAUNCH-SD-01] Generation-fence delivery custody across PostgreSQL and Redis.
--
-- `orders.fulfillmentModeVersion` is incremented in the same locked transaction
-- that resolves or changes delivery ownership. Every rider search/offer pins
-- that generation. A delayed VENDOR_DELIVERY cleanup can therefore retire only
-- its own or older artefacts, never a later PLATFORM_RIDER fallback.
--
-- FORWARD: additive columns + supporting journal index; existing orders start
-- at generation 0 and existing journal rows are nullable legacy generations.
-- ROLLBACK (code must be rolled back first):
--   DROP INDEX IF EXISTS "dispatch_searches_subjectId_deliveryAuthorityVersion_status_idx";
--   ALTER TABLE "dispatch_searches" DROP COLUMN IF EXISTS "deliveryAuthorityVersion";
--   ALTER TABLE "orders" DROP COLUMN IF EXISTS "fulfillmentModeVersion";

ALTER TABLE "orders"
  ADD COLUMN "fulfillmentModeVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "dispatch_searches"
  ADD COLUMN "deliveryAuthorityVersion" INTEGER;

CREATE INDEX "dispatch_searches_subjectId_deliveryAuthorityVersion_status_idx"
  ON "dispatch_searches"("subjectId", "deliveryAuthorityVersion", "status");
