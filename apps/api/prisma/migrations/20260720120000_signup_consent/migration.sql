-- SWIFT-AUD-D9-03: record signup consent (DPA-2023 demonstrability).
-- Additive only: two nullable columns; existing rows stay null (consent was
-- never recorded for them — that is the honest state).
ALTER TABLE "users" ADD COLUMN "acceptedTermsAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "tosVersion" TEXT;
