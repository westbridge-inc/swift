-- Phase 7 — Courier vertical: recipient, speed, payer, proof-of-delivery, tracking token

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "courierPayer" TEXT,
ADD COLUMN     "courierProofPhotoUrl" TEXT,
ADD COLUMN     "courierRecipientName" TEXT,
ADD COLUMN     "courierRecipientPhone" TEXT,
ADD COLUMN     "courierSpeed" TEXT,
ADD COLUMN     "courierTrackingToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "orders_courierTrackingToken_key" ON "orders"("courierTrackingToken");
