-- E16: courier pickup custody proof. PICKED_UP asserts physical custody, so
-- entering it now requires durable proof: the server-issued URL + the binding
-- rider at upload, the confirmed photo + GPS at pickup, and pickedUpAt
-- (already on orders) for the time.
--
-- FORWARD: five nullable columns only. Existing rows read NULL and every path
-- is unchanged until a courier runs the new pickup-proof flow.
-- BACKUP CHECKPOINT: the standard full pre-deploy backup (pg_dump -Fc), named
-- "pre-20260923000000" in the release record.
-- ROLLBACK: drop the five columns. They are nullable-only, so no data-dependent
-- semantics exist to restore and no constraint/index/enum must be unwound:
--   ALTER TABLE "orders"
--     DROP COLUMN "courierPickupProofIssuedUrl",
--     DROP COLUMN "courierPickupProofIssuedRiderId",
--     DROP COLUMN "courierPickupProofPhotoUrl",
--     DROP COLUMN "courierPickupProofLat",
--     DROP COLUMN "courierPickupProofLng";

ALTER TABLE "orders"
  ADD COLUMN "courierPickupProofIssuedUrl" TEXT,
  ADD COLUMN "courierPickupProofIssuedRiderId" TEXT,
  ADD COLUMN "courierPickupProofPhotoUrl" TEXT,
  ADD COLUMN "courierPickupProofLat" DOUBLE PRECISION,
  ADD COLUMN "courierPickupProofLng" DOUBLE PRECISION;
