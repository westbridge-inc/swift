-- CreateEnum
CREATE TYPE "GuardianStatus" AS ENUM ('MONITORING', 'CHECKIN_PENDING', 'ESCALATING', 'CLOSED');

-- CreateEnum
CREATE TYPE "GuardianCloseReason" AS ENUM ('TRIP_COMPLETED', 'TRIP_CANCELLED', 'ESCALATED', 'OPS_CLOSED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "enhancedSafetyMonitoring" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TripSafetySession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "orderId" TEXT NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "passengerUserId" TEXT,
    "driverUserId" TEXT NOT NULL,
    "status" "GuardianStatus" NOT NULL DEFAULT 'MONITORING',
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskFactors" JSONB,
    "plannedEtaAt" TIMESTAMP(3),
    "deviationState" JSONB,
    "lastLocationAt" TIMESTAMP(3),
    "checkinRequestedAt" TIMESTAMP(3),
    "checkinDeadlineAt" TIMESTAMP(3),
    "checkinRespondedAt" TIMESTAMP(3),
    "escalatedToSosId" TEXT,
    "closedAt" TIMESTAMP(3),
    "closeReason" "GuardianCloseReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripSafetySession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TripSafetySession_orderId_key" ON "TripSafetySession"("orderId");

-- CreateIndex
CREATE INDEX "TripSafetySession_tenantId_status_idx" ON "TripSafetySession"("tenantId", "status");

-- CreateIndex
CREATE INDEX "TripSafetySession_tenantId_driverUserId_idx" ON "TripSafetySession"("tenantId", "driverUserId");

