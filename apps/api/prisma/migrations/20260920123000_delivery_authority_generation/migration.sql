-- [LAUNCH-SD-01] Generation-fence delivery custody across PostgreSQL and Redis.
--
-- `orders.fulfillmentModeVersion` is incremented in the same locked transaction
-- that resolves or changes delivery ownership. Every rider search/offer pins
-- that generation. A delayed VENDOR_DELIVERY cleanup can therefore retire only
-- its own or older artefacts, never a later PLATFORM_RIDER fallback.
--
-- FORWARD: additive columns + supporting journal index; existing orders start
-- at generation 0 and existing journal rows are nullable legacy generations.
-- BACKUP CHECKPOINT: the standard full pre-deploy backup (pg_dump -Fc), named
-- "pre-20260920123000" in the release record.
-- ROLLBACK: the exact inverse below, verified on PostgreSQL 16, restores the
-- prior schema exactly and deletes this migration's _prisma_migrations row.
-- Precondition: roll the application back first and pause delivery dispatch
-- (no open rider searches or live offers); pause it again before re-applying.
-- Generation values are not restorable: a re-apply restarts every order at 0
-- and every journal row at NULL.
--   BEGIN;
--   SET LOCAL lock_timeout = '10s';
--   DO $$ BEGIN  -- non-blocking: say exactly what is about to be discarded
--     RAISE NOTICE 'discarding: % orders with fulfillmentModeVersion <> 0; % dispatch_searches rows with a pinned deliveryAuthorityVersion',
--       (SELECT count(*) FROM "orders" WHERE "fulfillmentModeVersion" <> 0),
--       (SELECT count(*) FROM "dispatch_searches" WHERE "deliveryAuthorityVersion" IS NOT NULL);
--   END $$;
--   DROP INDEX "dispatch_searches_subjectId_deliveryAuthorityVersion_status_idx";
--   ALTER TABLE "dispatch_searches" DROP COLUMN "deliveryAuthorityVersion";
--   ALTER TABLE "orders" DROP COLUMN "fulfillmentModeVersion";
--   DO $$ DECLARE n integer; BEGIN
--     DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260920123000_delivery_authority_generation';
--     GET DIAGNOSTICS n = ROW_COUNT;
--     IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
--   END $$;
--   COMMIT;

ALTER TABLE "orders"
  ADD COLUMN "fulfillmentModeVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "dispatch_searches"
  ADD COLUMN "deliveryAuthorityVersion" INTEGER;

CREATE INDEX "dispatch_searches_subjectId_deliveryAuthorityVersion_status_idx"
  ON "dispatch_searches"("subjectId", "deliveryAuthorityVersion", "status");
