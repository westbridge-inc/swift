-- [REPORT-016 F-016-04] Server-issued courier proof identity: the exact URL
-- /proof-photo minted for this order + the rider it was issued to. /proof
-- exact-matches these so a substring/crafted/foreign URL cannot fabricate a
-- delivery. Additive, nullable — legacy in-flight orders simply have none and
-- must re-upload through /proof-photo.
ALTER TABLE "orders" ADD COLUMN "courierProofIssuedUrl" TEXT;
ALTER TABLE "orders" ADD COLUMN "courierProofIssuedRiderId" TEXT;
