-- Phase 9 — Services vertical: ServiceProvider/ServiceJob/Qualification, chat job-scope, service rating types

-- CreateEnum
CREATE TYPE "ServiceJobStatus" AS ENUM ('REQUESTED', 'QUOTED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QualificationType" AS ENUM ('GEI_LICENCE', 'CVQ', 'GTEE', 'CITY_AND_GUILDS', 'OTHER');

-- CreateEnum
CREATE TYPE "QualificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RatingType" ADD VALUE 'CUSTOMER_TO_PROVIDER';
ALTER TYPE "RatingType" ADD VALUE 'PROVIDER_TO_CUSTOMER';

-- AlterTable
ALTER TABLE "chat_rooms" ADD COLUMN     "serviceJobId" TEXT,
ALTER COLUMN "orderId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "service_providers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trade" TEXT NOT NULL,
    "bio" TEXT,
    "portfolioPhotos" TEXT[],
    "selfSkilled" BOOLEAN NOT NULL DEFAULT true,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "averageRating" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "totalRatings" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_qualifications" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "type" "QualificationType" NOT NULL,
    "referenceNumber" TEXT,
    "status" "QualificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_jobs" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "photos" TEXT[],
    "status" "ServiceJobStatus" NOT NULL DEFAULT 'REQUESTED',
    "quoteAmount" DECIMAL(12,2),
    "scheduledFor" TIMESTAMP(3),
    "chatRoomId" TEXT,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_providers_userId_key" ON "service_providers"("userId");

-- CreateIndex
CREATE INDEX "service_providers_trade_idx" ON "service_providers"("trade");

-- CreateIndex
CREATE INDEX "service_qualifications_providerId_idx" ON "service_qualifications"("providerId");

-- CreateIndex
CREATE INDEX "service_jobs_customerId_idx" ON "service_jobs"("customerId");

-- CreateIndex
CREATE INDEX "service_jobs_providerId_idx" ON "service_jobs"("providerId");

-- CreateIndex
CREATE INDEX "service_jobs_status_idx" ON "service_jobs"("status");

-- AddForeignKey
ALTER TABLE "service_providers" ADD CONSTRAINT "service_providers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_qualifications" ADD CONSTRAINT "service_qualifications_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "service_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "service_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
