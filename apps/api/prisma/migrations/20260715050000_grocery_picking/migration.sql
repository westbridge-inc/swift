-- Grocery picking + substitution (§5.3) + stock adjustment audit trail (§5.6).
CREATE TYPE "SubstitutionStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED', 'REFUNDED');
CREATE TYPE "StockAdjustmentReason" AS ENUM ('RECEIVED', 'DAMAGED', 'MANUAL', 'RECONCILE', 'RETURN');

ALTER TABLE "items" ADD COLUMN "barcode" TEXT;
ALTER TABLE "items" ADD COLUMN "substitutionGroup" TEXT;

ALTER TABLE "order_items" ADD COLUMN "picked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "order_items" ADD COLUMN "subStatus" "SubstitutionStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "order_items" ADD COLUMN "substituteItemId" TEXT;
ALTER TABLE "order_items" ADD COLUMN "substituteName" TEXT;
ALTER TABLE "order_items" ADD COLUMN "substitutePrice" DECIMAL(10,2);

CREATE TABLE "stock_adjustments" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "StockAdjustmentReason" NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stock_adjustments_itemId_createdAt_idx" ON "stock_adjustments"("itemId", "createdAt");

ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
