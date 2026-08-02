-- CreateTable
CREATE TABLE "fee_receipts" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "subscriptionId" TEXT NOT NULL,
    "billingEventId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "channel" TEXT,
    "mmgRef" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_counters" (
    "tenantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "receipt_counters_pkey" PRIMARY KEY ("tenantId","year")
);

-- CreateTable
CREATE TABLE "collection_contacts" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "promisedDate" TIMESTAMP(3),
    "note" TEXT,
    "byAdminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fee_receipts_receiptNumber_key" ON "fee_receipts"("receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "fee_receipts_billingEventId_key" ON "fee_receipts"("billingEventId");

-- CreateIndex
CREATE INDEX "fee_receipts_subscriptionId_issuedAt_idx" ON "fee_receipts"("subscriptionId", "issuedAt");

-- CreateIndex
CREATE INDEX "fee_receipts_tenantId_issuedAt_idx" ON "fee_receipts"("tenantId", "issuedAt");

-- CreateIndex
CREATE INDEX "collection_contacts_subscriptionId_createdAt_idx" ON "collection_contacts"("subscriptionId", "createdAt");

