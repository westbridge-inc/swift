-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentStatus" ADD VALUE 'UNKNOWN';
ALTER TYPE "PaymentStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "PaymentStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "subscription_payments" ADD COLUMN     "clientKey" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "failureRaw" JSONB,
ADD COLUMN     "lastPolledAt" TIMESTAMP(3),
ADD COLUMN     "pollBackoffSec" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'WEEKLY_FEE';

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_clientKey_key" ON "subscription_payments"("clientKey");

-- CreateIndex
CREATE INDEX "subscription_payments_status_lastPolledAt_idx" ON "subscription_payments"("status", "lastPolledAt");

