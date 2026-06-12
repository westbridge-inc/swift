-- CreateEnum
CREATE TYPE "BillingEventType" AS ENUM ('CHARGE_ATTEMPT', 'CHARGE_SUCCESS', 'CHARGE_FAILED', 'PREPAID_TOPUP', 'SUSPENDED', 'REINSTATED', 'REMINDER', 'TIER_CHANGE');

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "billingMethod" "PaymentMethod" NOT NULL DEFAULT 'CASH',
ADD COLUMN     "nextRetryAt" TIMESTAMP(3),
ADD COLUMN     "paymentToken" TEXT;

-- CreateTable
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "type" "BillingEventType" NOT NULL,
    "amount" DECIMAL(12,2),
    "currencyCode" TEXT NOT NULL DEFAULT 'GYD',
    "idempotencyKey" TEXT NOT NULL,
    "paymentRef" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_idempotencyKey_key" ON "billing_events"("idempotencyKey");

-- CreateIndex
CREATE INDEX "billing_events_subscriptionId_idx" ON "billing_events"("subscriptionId");

-- CreateIndex
CREATE INDEX "billing_events_type_idx" ON "billing_events"("type");

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

