-- [ALG-25] What the refund algorithm computed when a return was requested:
-- the case (CASH_PRE_HANDOVER | CASH_POST_HANDOVER | MMG_BLOCKED), the amount
-- and the sentence. Additive, nullable; nothing is rewritten, no money moves.
SET lock_timeout = '10s';
ALTER TABLE "return_requests" ADD COLUMN "refundKind" TEXT;
ALTER TABLE "return_requests" ADD COLUMN "refundAmount" DECIMAL(12,2);
ALTER TABLE "return_requests" ADD COLUMN "refundSentence" TEXT;
