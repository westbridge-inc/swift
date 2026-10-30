-- [CHAINS PR3 · owner 29 Oct 2026: "one brand card ('Royal Castle') opening the nearest open branch that delivers to
-- them; customer can pick another branch"] EXPAND only.
--
-- FORWARD
--  1. vendor_owners."brandName" TEXT NULL: the chain's name customers see once for all its branches. Set by a person
--     at Swift (admin, with a reason); null = no brand (every store listed on its own, exactly as before).
--     CHECK: absent, or 2-60 characters with no leading/trailing spaces.
--  2. vendors."brandListedAlone" BOOLEAN NOT NULL DEFAULT false: a branch Swift lists on its own card even though its
--     owner has a brand (admin "split"). A constant default: no table rewrite.
--
-- ROLLBACK: rollback.sql beside this file. Roll the application back first (customers then see every branch on its
-- own card again, as before this change).

SET lock_timeout = '10s';

ALTER TABLE "vendor_owners" ADD COLUMN "brandName" TEXT;
ALTER TABLE "vendor_owners" ADD CONSTRAINT "vendor_owners_brand_name_shape"
  CHECK ("brandName" IS NULL OR (char_length("brandName") BETWEEN 2 AND 60 AND "brandName" = btrim("brandName")));
ALTER TABLE "vendors" ADD COLUMN "brandListedAlone" BOOLEAN NOT NULL DEFAULT false;
