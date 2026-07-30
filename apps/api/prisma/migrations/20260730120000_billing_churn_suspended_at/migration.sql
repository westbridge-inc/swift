-- AlterEnum
ALTER TYPE "BillingEventType" ADD VALUE 'CHURNED';

-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'CHURNED';

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "suspendedAt" TIMESTAMP(3);

