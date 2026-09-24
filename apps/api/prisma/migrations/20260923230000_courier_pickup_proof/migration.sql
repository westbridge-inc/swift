-- [E16] Courier pickup custody proof. PICKED_UP asserts that the rider
-- physically holds someone else's parcel, so a courier now enters it only with
-- durable evidence: the photo URL the server issued and the rider it was
-- issued to (written at upload), then the bound photo and the rider's GPS fix
-- (written in the PICKED_UP transition's own commit). The time is the existing
-- "pickedUpAt".
--
-- FORWARD: five nullable columns with no default, constraint or index, so a
-- catalogue-only change on PostgreSQL 11+ (no table rewrite; a brief ACCESS
-- EXCLUSIVE lock on "orders"). Existing rows read NULL; only the pickup-proof
-- routes write these columns.
-- BACKUP CHECKPOINT: the standard full pre-deploy backup (pg_dump -Fc), named
-- "pre-20260923230000" in the release record.
-- ROLLBACK: the exact inverse below, verified on PostgreSQL 16 (PostGIS 3.4),
-- restores the prior schema exactly and deletes this migration's
-- _prisma_migrations row, so a later `prisma migrate deploy` re-applies it.
-- Precondition: roll the application back first (the previous application
-- never reads these columns); forward repair is preferred. Pickup evidence
-- recorded since the deploy is discarded from the order rows; the photos stay
-- in storage under courier-proof/<orderId>/pickup/, and each PICKED_UP
-- status-log note keeps its gps: text.
--   BEGIN;
--   SET LOCAL lock_timeout = '10s';
--   DO $$ BEGIN  -- non-blocking: say exactly what is about to be discarded
--     RAISE NOTICE 'discarding: % orders with an issued pickup photo; % with a bound pickup photo',
--       (SELECT count(*) FROM "orders" WHERE "courierPickupProofIssuedUrl" IS NOT NULL),
--       (SELECT count(*) FROM "orders" WHERE "courierPickupProofPhotoUrl" IS NOT NULL);
--   END $$;
--   ALTER TABLE "orders"
--     DROP COLUMN "courierPickupProofIssuedUrl",
--     DROP COLUMN "courierPickupProofIssuedRiderId",
--     DROP COLUMN "courierPickupProofPhotoUrl",
--     DROP COLUMN "courierPickupProofLat",
--     DROP COLUMN "courierPickupProofLng";
--   DO $$ DECLARE n integer; BEGIN
--     DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260923230000_courier_pickup_proof';
--     GET DIAGNOSTICS n = ROW_COUNT;
--     IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
--   END $$;
--   COMMIT;

ALTER TABLE "orders"
  ADD COLUMN "courierPickupProofIssuedUrl" TEXT,
  ADD COLUMN "courierPickupProofIssuedRiderId" TEXT,
  ADD COLUMN "courierPickupProofPhotoUrl" TEXT,
  ADD COLUMN "courierPickupProofLat" DOUBLE PRECISION,
  ADD COLUMN "courierPickupProofLng" DOUBLE PRECISION;
