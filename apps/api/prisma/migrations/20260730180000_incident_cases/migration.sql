-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('S0', 'S1', 'S2', 'S3', 'S4');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'TRIAGED', 'INVESTIGATING', 'DECIDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "IncidentIntake" AS ENUM ('SOS_RESOLUTION', 'IN_TRIP_REPORT', 'POST_TRIP_REPORT', 'RATING_FLAG', 'OPS_CREATED', 'SYSTEM_AUTO');

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "safetySuspendedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "riders" ADD COLUMN     "safetySuspendedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "IncidentCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "caseNumber" TEXT NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "severity" "IncidentSeverity" NOT NULL,
    "category" TEXT NOT NULL,
    "intake" "IncidentIntake" NOT NULL,
    "subjectUserId" TEXT NOT NULL,
    "reporterUserId" TEXT,
    "orderId" TEXT,
    "sosAlertId" TEXT,
    "summary" TEXT NOT NULL,
    "details" JSONB,
    "escalatedPoliceAt" TIMESTAMP(3),
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "slaAckBy" TIMESTAMP(3) NOT NULL,
    "slaDecideBy" TIMESTAMP(3) NOT NULL,
    "ackedAt" TIMESTAMP(3),
    "ackedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decisionCode" TEXT,
    "decisionNotes" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "interimAction" TEXT NOT NULL DEFAULT 'NONE',
    "patternFlaggedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncidentCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IncidentCase_caseNumber_key" ON "IncidentCase"("caseNumber");

-- CreateIndex
CREATE INDEX "IncidentCase_tenantId_status_severity_idx" ON "IncidentCase"("tenantId", "status", "severity");

-- CreateIndex
CREATE INDEX "IncidentCase_subjectUserId_createdAt_idx" ON "IncidentCase"("subjectUserId", "createdAt");

-- CreateIndex
CREATE INDEX "IncidentCase_tenantId_slaAckBy_idx" ON "IncidentCase"("tenantId", "slaAckBy");

