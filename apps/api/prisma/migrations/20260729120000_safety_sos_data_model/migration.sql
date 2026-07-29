-- CreateEnum
CREATE TYPE "SosStatus" AS ENUM ('TRIGGER_PENDING', 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SosTriggerSource" AS ENUM ('BUTTON', 'CHECKIN_TIMEOUT', 'GUARDIAN_ESCALATION', 'OPS_MANUAL');

-- CreateEnum
CREATE TYPE "SosCancelReason" AS ENUM ('SLIDE_CANCEL', 'USER_MARKED_SAFE', 'OPS_RESOLVED_FALSE_ALARM');

-- CreateEnum
CREATE TYPE "SosResolutionCode" AS ENUM ('SAFE_CONFIRMED', 'POLICE_INVOLVED', 'MEDICAL', 'FALSE_ALARM', 'ABUSE', 'UNREACHABLE_CLOSED');

-- CreateTable
CREATE TABLE "SosAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "actorUserId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "orderId" TEXT,
    "orderType" "OrderType",
    "counterpartyUserId" TEXT,
    "status" "SosStatus" NOT NULL DEFAULT 'TRIGGER_PENDING',
    "triggerSource" "SosTriggerSource" NOT NULL DEFAULT 'BUTTON',
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graceEndsAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" "SosCancelReason",
    "userSafeFlaggedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionCode" "SosResolutionCode",
    "resolutionNotes" TEXT,
    "triggerLat" DOUBLE PRECISION,
    "triggerLng" DOUBLE PRECISION,
    "triggerAccuracyM" DOUBLE PRECISION,
    "triggerAddressText" TEXT,
    "clientCreatedAt" TIMESTAMP(3),
    "clientIdempotencyKey" TEXT,
    "deliveryReceipts" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SosAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyContact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "relationship" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmergencyContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SosAlert_clientIdempotencyKey_key" ON "SosAlert"("clientIdempotencyKey");

-- CreateIndex
CREATE INDEX "SosAlert_tenantId_status_triggeredAt_idx" ON "SosAlert"("tenantId", "status", "triggeredAt");

-- CreateIndex
CREATE INDEX "SosAlert_actorUserId_idx" ON "SosAlert"("actorUserId");

-- CreateIndex
CREATE INDEX "SosAlert_orderId_idx" ON "SosAlert"("orderId");

-- CreateIndex
CREATE INDEX "EmergencyContact_userId_idx" ON "EmergencyContact"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyContact_userId_phoneE164_key" ON "EmergencyContact"("userId", "phoneE164");

