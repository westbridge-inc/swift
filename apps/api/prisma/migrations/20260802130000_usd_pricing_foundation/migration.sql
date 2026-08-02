-- AlterTable
ALTER TABLE "billing_events" ADD COLUMN     "amountUsd" DECIMAL(10,2),
ADD COLUMN     "fxRateId" TEXT,
ADD COLUMN     "fxRateUsed" DECIMAL(12,6);

-- CreateTable
CREATE TABLE "price_book_entries" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tier" TEXT,
    "amountUsd" DECIMAL(10,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_book_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "id" TEXT NOT NULL,
    "base" TEXT NOT NULL DEFAULT 'USD',
    "quote" TEXT NOT NULL,
    "rate" DECIMAL(12,6) NOT NULL,
    "source" TEXT NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_billing_currency" (
    "tenantId" TEXT NOT NULL,
    "settlementCurrency" TEXT NOT NULL DEFAULT 'GYD',
    "roundingIncrement" DECIMAL(10,2) NOT NULL DEFAULT 100,
    "displayDual" BOOLEAN NOT NULL DEFAULT true,
    "usdPricingEnabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tenant_billing_currency_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex
CREATE INDEX "price_book_entries_role_active_idx" ON "price_book_entries"("role", "active");

-- CreateIndex
CREATE INDEX "fx_rates_quote_effectiveFrom_idx" ON "fx_rates"("quote", "effectiveFrom");

