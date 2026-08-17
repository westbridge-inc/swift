-- [REPORT-014 F-014-04] Offer attempt identity: every dispatch offer install
-- mints an opaque attempt id, and the delivery-evidence row records WHICH
-- attempt it proves. Timeout accounting for attempt N can then never read an
-- older attempt's render proof (or lack of one) as evidence about N.
-- Additive, nullable — legacy rows and VENDOR_ORDER alerts simply have none.
ALTER TABLE "alert_deliveries" ADD COLUMN "offerAttemptId" TEXT;
