-- CreateEnum
CREATE TYPE "TrustLevel" AS ENUM ('L1', 'L2', 'L3');

-- CreateEnum
CREATE TYPE "VerificationDocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "FulfillmentType" AS ENUM ('DELIVERY', 'APPOINTMENT', 'PICKUP');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'MOVER';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VendorType" ADD VALUE 'STORE';
ALTER TYPE "VendorType" ADD VALUE 'SERVICE';

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "bookingConfig" JSONB,
ADD COLUMN     "fulfillment" "FulfillmentType" NOT NULL DEFAULT 'DELIVERY';

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "autoSuspendEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "currencyCode" TEXT NOT NULL DEFAULT 'GYD';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "countryCode" TEXT NOT NULL DEFAULT 'GY',
ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "trustLevel" "TrustLevel" NOT NULL DEFAULT 'L1';

-- AlterTable
-- qrSlug: add nullable, backfill existing vendors from their unique slug,
-- then lock to NOT NULL. New rows get a cuid() from the Prisma client default.
ALTER TABLE "vendors" ADD COLUMN     "qrSlug" TEXT;
UPDATE "vendors" SET "qrSlug" = "slug" WHERE "qrSlug" IS NULL;
ALTER TABLE "vendors" ALTER COLUMN   "qrSlug" SET NOT NULL;

-- CreateTable
CREATE TABLE "country_configs" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "currencySymbol" TEXT NOT NULL DEFAULT '$',
    "usdExchangeRate" DECIMAL(12,4) NOT NULL,
    "idGateThresholdUsd" DECIMAL(10,2) NOT NULL DEFAULT 50,
    "subscriptionTiers" JSONB NOT NULL,
    "documentChecklists" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "country_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_documents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "docType" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "status" "VerificationDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strikes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "reason" TEXT NOT NULL,
    "phone" TEXT,
    "addressKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strikes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prepaid_balances" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'GYD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prepaid_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "country_configs_code_key" ON "country_configs"("code");

-- CreateIndex
CREATE INDEX "verification_documents_status_idx" ON "verification_documents"("status");

-- CreateIndex
CREATE INDEX "verification_documents_userId_idx" ON "verification_documents"("userId");

-- CreateIndex
CREATE INDEX "verification_documents_expiresAt_idx" ON "verification_documents"("expiresAt");

-- CreateIndex
CREATE INDEX "strikes_userId_idx" ON "strikes"("userId");

-- CreateIndex
CREATE INDEX "strikes_phone_idx" ON "strikes"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "prepaid_balances_subscriptionId_key" ON "prepaid_balances"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_qrSlug_key" ON "vendors"("qrSlug");

-- AddForeignKey
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prepaid_balances" ADD CONSTRAINT "prepaid_balances_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

