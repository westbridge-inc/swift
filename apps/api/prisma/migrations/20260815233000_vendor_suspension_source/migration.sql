-- [REPORT-013 F-013-07] Which authority suspended the vendor: BILLING
-- (payment lifts it) vs ADMIN (payment must not). Reinstate CAS-matches
-- BILLING only.
ALTER TABLE "vendors" ADD COLUMN "suspensionSource" TEXT;
