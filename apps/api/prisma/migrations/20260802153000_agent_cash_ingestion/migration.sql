-- CreateTable
CREATE TABLE "mmg_agent_payments" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "mmgTxnId" TEXT,
    "sanRaw" TEXT NOT NULL,
    "sanNormalized" CHAR(10),
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "subscriptionId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currencyCode" CHAR(3) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "agentRef" TEXT,
    "payerMsisdn" TEXT,
    "status" TEXT NOT NULL,
    "failureCode" TEXT,
    "raw" JSONB NOT NULL,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mmg_agent_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mmg_agent_payments_status_createdAt_idx" ON "mmg_agent_payments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "mmg_agent_payments_sanNormalized_idx" ON "mmg_agent_payments"("sanNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "mmg_agent_payments_channel_externalId_key" ON "mmg_agent_payments"("channel", "externalId");

