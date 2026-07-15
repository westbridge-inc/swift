-- CreateEnum
CREATE TYPE "CashSettlementStatus" AS ENUM ('OWED', 'RIDER_CONFIRMED', 'STORE_CONFIRMED', 'SETTLED');

-- CreateTable
CREATE TABLE "delivery_cash_settlements" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "CashSettlementStatus" NOT NULL DEFAULT 'OWED',
    "riderConfirmedAt" TIMESTAMP(3),
    "storeConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_cash_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_cash_settlements_orderId_key" ON "delivery_cash_settlements"("orderId");

-- CreateIndex
CREATE INDEX "delivery_cash_settlements_riderId_status_idx" ON "delivery_cash_settlements"("riderId", "status");

-- CreateIndex
CREATE INDEX "delivery_cash_settlements_vendorId_status_idx" ON "delivery_cash_settlements"("vendorId", "status");

-- AddForeignKey
ALTER TABLE "delivery_cash_settlements" ADD CONSTRAINT "delivery_cash_settlements_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_cash_settlements" ADD CONSTRAINT "delivery_cash_settlements_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_cash_settlements" ADD CONSTRAINT "delivery_cash_settlements_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

