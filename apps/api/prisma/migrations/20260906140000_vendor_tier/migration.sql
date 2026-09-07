-- CreateEnum
CREATE TYPE "VendorTier" AS ENUM ('UNREGISTERED', 'REGISTERED');

-- AlterTable
ALTER TABLE "country_configs" ADD COLUMN     "vendorTierCaps" JSONB;

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "tier" "VendorTier" NOT NULL DEFAULT 'REGISTERED',
ADD COLUMN     "tierChangedAt" TIMESTAMP(3),
ADD COLUMN     "tierNote" TEXT;

