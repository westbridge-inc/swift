-- [AUD-L4-016] A failed SOS delivery pages on-call operations exactly once.
-- The claim is a lease; the ops alert that covered the failure marks it done.
ALTER TABLE "sos_escalations" ADD COLUMN "failurePageClaimedAt" TIMESTAMP(3), ADD COLUMN "failurePageOpsAlertId" TEXT;
