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
-- ROLLBACK (honest scope). PostgreSQL cannot drop a value from an enum without
-- rebuilding the type, so the rollback leaves RETURNING and RETURNED in
-- "OrderStatus" (inert once no row uses them) and drops only the columns.
-- PRECONDITION: no order may be in RETURNING or RETURNED, because the previous
-- application's Prisma client cannot read those values (any query that returns
-- such a row throws). Close every open return first (support moves each order
-- to a status the old code knows, recording why), then roll the application
-- back, then run, in one transaction:
--   ALTER TABLE "orders"
--     DROP COLUMN "courierReturnReason",
--     DROP COLUMN "courierReturnRequestedAt",
--     DROP COLUMN "courierReturnProofPhotoUrl",
--     DROP COLUMN "courierReturnedAt";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260924160000_courier_return_states';

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'RETURNING';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'RETURNED';

ALTER TABLE "orders"
  ADD COLUMN "courierReturnReason" TEXT,
  ADD COLUMN "courierReturnRequestedAt" TIMESTAMP(3),
  ADD COLUMN "courierReturnProofPhotoUrl" TEXT,
  ADD COLUMN "courierReturnedAt" TIMESTAMP(3);
