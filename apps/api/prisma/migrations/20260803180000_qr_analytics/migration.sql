-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ScanDecision" ADD VALUE 'STORE_VIEW';
ALTER TYPE "ScanDecision" ADD VALUE 'INSTALL_TAP';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "attributionQrCodeId" TEXT,
ADD COLUMN     "channel" TEXT;

-- CreateIndex
CREATE INDEX "orders_attributionQrCodeId_idx" ON "orders"("attributionQrCodeId");

