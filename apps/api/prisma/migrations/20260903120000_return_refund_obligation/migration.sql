-- [A-13] A return could go from REQUESTED to a terminal REFUNDED in one click,
-- with only an optional note. The customer and operations then both saw a
-- finished refund while the money was still owed and nothing recorded who was
-- going to send it, how much, or whether it ever arrived.
--
-- REFUND_DUE is the obligation. Deciding to refund records that money is OWED;
-- only reconciled evidence closes it.
ALTER TYPE "ReturnStatus" ADD VALUE IF NOT EXISTS 'REFUND_DUE' BEFORE 'REFUNDED';

ALTER TABLE "return_requests" ADD COLUMN "refundRef" TEXT;
ALTER TABLE "return_requests" ADD COLUMN "refundPaidAmount" DECIMAL(12,2);
ALTER TABLE "return_requests" ADD COLUMN "refundPaidById" TEXT;
ALTER TABLE "return_requests" ADD COLUMN "refundPaidAt" TIMESTAMP(3);

-- One transfer settles one return. The build FAILS on existing duplicates, and
-- that is correct: it would mean two returns were closed against one payment.
CREATE UNIQUE INDEX "return_requests_refundRef_key" ON "return_requests"("refundRef");
