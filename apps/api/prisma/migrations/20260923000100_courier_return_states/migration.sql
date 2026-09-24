-- [E17] Courier return-to-sender after custody (pilot). A parcel in rider
-- custody can now be returned: the assigned mover (or support, via the
-- support ticket) starts a return from any custody state (RETURNING) and
-- closes it with a return proof photo (RETURNED).
--
-- RETURNING is classified MOVER_HOLDING in the custody law, so the rescue
-- watchdog can never auto-release a returning parcel and the sender can never
-- cancel it; RETURNED is terminal and releases the mover. No fee is minted for
-- the return leg: the pilot keeps whatever was already collected peer-to-peer
-- at pickup (Swift never held the money) and the support ticket is the record
-- for any manual adjustment.
--
-- FORWARD: two enum values + four nullable columns. Existing rows are
-- untouched (all four columns NULL; no row is given a new status).
--
-- ROLLBACK: drop the four columns, then delete this migration's
-- _prisma_migrations row:
--   ALTER TABLE "orders"
--     DROP COLUMN "courierReturnReason",
--     DROP COLUMN "courierReturnRequestedAt",
--     DROP COLUMN "courierReturnProofPhotoUrl",
--     DROP COLUMN "courierReturnedAt";
-- PostgreSQL cannot DROP a value from an enum without a full type rebuild, so
-- the rollback deliberately does NOT rebuild the type: the two unused values
-- are inert. Precondition: roll the application back first and have no orders
-- in RETURNING (RETURNED rows would lose their status column on any rebuild,
-- which this rollback never performs).

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'RETURNING';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'RETURNED';

ALTER TABLE "orders"
  ADD COLUMN "courierReturnReason" TEXT,
  ADD COLUMN "courierReturnRequestedAt" TIMESTAMP(3),
  ADD COLUMN "courierReturnProofPhotoUrl" TEXT,
  ADD COLUMN "courierReturnedAt" TIMESTAMP(3);
