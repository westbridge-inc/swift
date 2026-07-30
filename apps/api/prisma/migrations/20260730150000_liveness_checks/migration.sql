-- CreateEnum
CREATE TYPE "LivenessPurpose" AS ENUM ('GO_ONLINE', 'RANDOM_MID_SHIFT', 'RIDER_REPORTED');

-- CreateEnum
CREATE TYPE "LivenessOutcome" AS ENUM ('PASS', 'BORDERLINE', 'FAIL', 'ERROR_FAIL_OPEN', 'ERROR_FAIL_CLOSED');

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "lastLivenessPassAt" TIMESTAMP(3),
ADD COLUMN     "livenessLockedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "riders" ADD COLUMN     "lastLivenessPassAt" TIMESTAMP(3),
ADD COLUMN     "livenessLockedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LivenessCheck" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "userId" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "purpose" "LivenessPurpose" NOT NULL DEFAULT 'GO_ONLINE',
    "selfieUrl" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "outcome" "LivenessOutcome" NOT NULL,
    "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LivenessCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LivenessCheck_tenantId_userId_createdAt_idx" ON "LivenessCheck"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "LivenessCheck_tenantId_reviewRequired_reviewedAt_idx" ON "LivenessCheck"("tenantId", "reviewRequired", "reviewedAt");

