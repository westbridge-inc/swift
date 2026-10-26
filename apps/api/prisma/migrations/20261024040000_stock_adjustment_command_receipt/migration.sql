-- [MASTER-025] A stock adjustment is one command. The adjustment row becomes
-- its durable receipt: the client's command key (unique per item) and the
-- canonical movement it produced, written in the movement's own transaction.
-- Additive and nullable: existing rows and keyless clients are unchanged.
-- The unique index is built under a short lock wait: a busy table fails the
-- migration fast instead of queueing every stock write behind it.
SET lock_timeout = '10s';
ALTER TABLE "stock_adjustments" ADD COLUMN "commandKey" TEXT;
ALTER TABLE "stock_adjustments" ADD COLUMN "movementId" TEXT;
CREATE UNIQUE INDEX "stock_adjustments_itemId_commandKey_key" ON "stock_adjustments"("itemId", "commandKey");
