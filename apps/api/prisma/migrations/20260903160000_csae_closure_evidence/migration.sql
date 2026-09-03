-- [A-17] A child-safety (CSAE) report closed exactly like a spam report: one
-- click to ACTIONED or DISMISSED with an OPTIONAL free-text note. Swift's own
-- published child-safety standards promise that confirmed material is removed,
-- the account banned, the matter reported to the relevant authorities, and the
-- evidence preserved — and nothing in the system recorded or required any of
-- it. "Handled" and "nobody looked properly" produced identical rows.
ALTER TABLE "content_reports" ADD COLUMN "disposition" TEXT;
ALTER TABLE "content_reports" ADD COLUMN "enforcementRef" TEXT;
ALTER TABLE "content_reports" ADD COLUMN "authorityRef" TEXT;
ALTER TABLE "content_reports" ADD COLUMN "evidencePreserved" BOOLEAN;

-- Dual control on dismissal: one reviewer proposes, a DIFFERENT one confirms.
ALTER TABLE "content_reports" ADD COLUMN "dismissProposedBy" TEXT;
ALTER TABLE "content_reports" ADD COLUMN "dismissProposedAt" TIMESTAMP(3);

-- The queue that matters: child-safety reports still open, oldest first.
CREATE INDEX "content_reports_csae_open_idx" ON "content_reports"("createdAt")
  WHERE "reason" = 'CSAE' AND "status" IN ('PENDING', 'REVIEWING');
