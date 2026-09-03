-- [A-14] An admin cancelling a cash order with `refund: true` wrote REFUNDED —
-- a terminal state whose name asserts the customer has their money back — with
-- no amount, no actor, and no evidence that a single dollar moved. On the cash
-- rail the STORE holds the customer's money, not Swift, so that terminal was a
-- claim about somebody else's cash drawer.
--
-- Deciding now records an OBLIGATION; only reconciled evidence closes it.
ALTER TABLE "orders" ADD COLUMN "refundOwedAmount" DECIMAL(12,2);
ALTER TABLE "orders" ADD COLUMN "refundOwedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "refundOwedById" TEXT;
ALTER TABLE "orders" ADD COLUMN "refundRef" TEXT;
ALTER TABLE "orders" ADD COLUMN "refundPaidAmount" DECIMAL(12,2);
ALTER TABLE "orders" ADD COLUMN "refundSettledById" TEXT;
ALTER TABLE "orders" ADD COLUMN "refundSettledAt" TIMESTAMP(3);

-- One handover settles ONE order. The build FAILS on existing duplicates, and
-- that is correct: it would mean two orders were closed against one refund.
CREATE UNIQUE INDEX "orders_refundRef_key" ON "orders"("refundRef");

-- The unpaid-refund queue the register asks for: obligations by age.
CREATE INDEX "orders_refund_outstanding_idx" ON "orders"("refundOwedAt") WHERE "refundOwedAt" IS NOT NULL AND "refundSettledAt" IS NULL;
