-- [W-25] "MMG payment received" is a store's word, and the row now says so:
-- the provider reference the store read out of its own wallet, who attested,
-- and when. The reference is UNIQUE across orders, so one transaction cannot
-- be used to mark two orders paid.
ALTER TABLE "orders" ADD COLUMN "mmgAttestedRef" TEXT;
ALTER TABLE "orders" ADD COLUMN "mmgAttestedById" TEXT;
ALTER TABLE "orders" ADD COLUMN "mmgAttestedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "orders_mmgAttestedRef_key" ON "orders"("mmgAttestedRef");
