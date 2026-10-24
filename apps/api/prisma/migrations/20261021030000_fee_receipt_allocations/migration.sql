-- [R12 · REVIEW-G #1771 S3-1 option a] Which weekly-fee payment paid what.
-- Every credit to a partner's weekly-fee money already issues one receipt for
-- the amount credited (fee_receipts). Each debit of that money now records
-- which receipts it used, oldest money first: a week bought (with its period),
-- a payment MMG returned, a refund set aside, and a set-aside returned unpaid
-- (negative rows giving that money back). A receipt then prints the week(s)
-- its money covered instead of a week inferred from clocks.
-- Receipts issued before this migration keep weeksTracked = false: what they
-- paid is not known, so they keep the "paid toward" line and are never used by
-- the allocation. Only the code that records the allocations issues a receipt
-- with weeksTracked = true (the column default stays false, so a server still
-- running the previous code during a deploy issues an untracked receipt).
SET lock_timeout = '10s';

ALTER TABLE "fee_receipts" ADD COLUMN "weeksTracked" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "fee_receipt_allocations" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "billingEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fee_receipt_allocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fee_receipt_allocations_kind_check" CHECK ("kind" IN ('WEEK', 'RETURNED', 'REFUND_SET_ASIDE', 'REFUND_RELEASED')),
    -- A release gives money back (negative); every other kind uses it (positive).
    CONSTRAINT "fee_receipt_allocations_sign_check" CHECK ((("kind" = 'REFUND_RELEASED') AND "amount" < 0) OR (("kind" <> 'REFUND_RELEASED') AND "amount" > 0)),
    -- Only a week carries its period, and always both ends of it.
    CONSTRAINT "fee_receipt_allocations_period_check" CHECK (
      (("kind" = 'WEEK') AND "periodStart" IS NOT NULL AND "periodEnd" IS NOT NULL AND "periodEnd" > "periodStart")
      OR (("kind" <> 'WEEK') AND "periodStart" IS NULL AND "periodEnd" IS NULL))
);

CREATE UNIQUE INDEX "fee_receipt_allocations_billingEventId_receiptId_key" ON "fee_receipt_allocations"("billingEventId", "receiptId");
CREATE INDEX "fee_receipt_allocations_receiptId_idx" ON "fee_receipt_allocations"("receiptId");
CREATE INDEX "fee_receipt_allocations_subscriptionId_createdAt_idx" ON "fee_receipt_allocations"("subscriptionId", "createdAt");

-- A row goes only with its receipt (receipts outlive their account; a test or
-- tenant purge that removes a receipt removes what it paid).
ALTER TABLE "fee_receipt_allocations" ADD CONSTRAINT "fee_receipt_allocations_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "fee_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only: what a payment paid is never rewritten.
CREATE OR REPLACE FUNCTION fee_receipt_allocation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A fee receipt allocation is immutable' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER fee_receipt_allocations_immutable BEFORE UPDATE ON "fee_receipt_allocations"
  FOR EACH ROW EXECUTE FUNCTION fee_receipt_allocation_immutable();
