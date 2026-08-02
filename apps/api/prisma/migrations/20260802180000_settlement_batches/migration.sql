-- CreateTable
CREATE TABLE "settlement_batches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "provider" TEXT NOT NULL DEFAULT 'MMG',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "grossGyd" DECIMAL(12,2) NOT NULL,
    "providerFeeGyd" DECIMAL(12,2),
    "expectedNetGyd" DECIMAL(12,2),
    "depositedGyd" DECIMAL(12,2),
    "depositedAt" TIMESTAMP(3),
    "bankRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'EXPECTED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlement_batches_status_idx" ON "settlement_batches"("status");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batches_tenantId_provider_periodStart_key" ON "settlement_batches"("tenantId", "provider", "periodStart");

