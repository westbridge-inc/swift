-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('AUTO_APPROVED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAID');

-- AlterTable
ALTER TABLE "country_configs" ADD COLUMN     "cashRules" JSONB;

-- CreateTable
CREATE TABLE "reimbursement_claims" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "gpsLat" DOUBLE PRECISION NOT NULL,
    "gpsLng" DOUBLE PRECISION NOT NULL,
    "photoUrl" TEXT,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "flags" TEXT[],
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paymentRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reimbursement_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reimbursement_claims_orderId_key" ON "reimbursement_claims"("orderId");

-- CreateIndex
CREATE INDEX "reimbursement_claims_riderId_idx" ON "reimbursement_claims"("riderId");

-- CreateIndex
CREATE INDEX "reimbursement_claims_customerId_idx" ON "reimbursement_claims"("customerId");

-- CreateIndex
CREATE INDEX "reimbursement_claims_status_idx" ON "reimbursement_claims"("status");

-- CreateIndex
CREATE INDEX "reimbursement_claims_createdAt_idx" ON "reimbursement_claims"("createdAt");

