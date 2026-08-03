-- CreateTable
CREATE TABLE "pending_attributions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "qrCodeId" TEXT NOT NULL,
    "destinationPath" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "fpHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "claimedInstallId" TEXT,

    CONSTRAINT "pending_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribution_claims" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "installId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "qrCodeId" TEXT,
    "destinationPath" TEXT,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribution_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_attributions_fpHash_expiresAt_idx" ON "pending_attributions"("fpHash", "expiresAt");

-- CreateIndex
CREATE INDEX "pending_attributions_expiresAt_idx" ON "pending_attributions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "attribution_claims_installId_key" ON "attribution_claims"("installId");

