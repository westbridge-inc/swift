-- Durable delivery checkpoints for billing notices already represented by
-- BillingEvent. Existing financial events and older best-effort notices remain
-- unchanged; only noticeVersion=1 notes enter the new retry worker.
SET lock_timeout = '10s';
ALTER TABLE "billing_events"
  ADD COLUMN "noticeLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "noticeLeaseToken" TEXT,
  ADD COLUMN "noticeSmsSentAt" TIMESTAMP(3);
CREATE INDEX "billing_events_notice_lease_idx"
  ON "billing_events"("deliveredAt", "noticeLeaseUntil", "createdAt")
  WHERE "deliveredAt" IS NULL;
