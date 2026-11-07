-- [CHAINS · owner 29 Oct 2026] A chain deal: one weekly fee Swift negotiated with a business owner for each of its
-- branches (decision 49 stays: no automatic multi-store discount; a person at Swift sets a deal, with a reason).
-- EXPAND only: five nullable columns on vendor_owners, empty for every existing owner (no deal = today's fees).
--
-- FORWARD
--  1. vendor_owners."dealWeeklyRate" (whole units of "dealCurrencyCode"), "dealCurrencyCode", "dealSetAt",
--     "dealSetBy" (the admin's user id) and "dealReason".
--  2. CHECK: a deal is whole and positive, and is either fully stated (rate, currency, when, who, why) or absent.
--
-- ROLLBACK: rollback.sql beside this file (forward repair is preferred). Roll the application back first: the
-- previous application never reads these columns. The guard refuses while any owner holds a deal (the branches'
-- own weekly fees keep the deal either way: it is written on each branch's subscription as its custom rate).

SET lock_timeout = '10s';

ALTER TABLE "vendor_owners"
  ADD COLUMN "dealWeeklyRate" DECIMAL(10,2),
  ADD COLUMN "dealCurrencyCode" TEXT,
  ADD COLUMN "dealSetAt" TIMESTAMP(3),
  ADD COLUMN "dealSetBy" TEXT,
  ADD COLUMN "dealReason" TEXT;

ALTER TABLE "vendor_owners" ADD CONSTRAINT "vendor_owners_deal_whole_positive"
  CHECK ("dealWeeklyRate" IS NULL OR ("dealWeeklyRate" > 0 AND "dealWeeklyRate" = trunc("dealWeeklyRate")));
ALTER TABLE "vendor_owners" ADD CONSTRAINT "vendor_owners_deal_stated"
  CHECK (
    ("dealWeeklyRate" IS NULL AND "dealCurrencyCode" IS NULL AND "dealSetAt" IS NULL AND "dealSetBy" IS NULL AND "dealReason" IS NULL)
    OR ("dealWeeklyRate" IS NOT NULL AND "dealCurrencyCode" IS NOT NULL AND "dealSetAt" IS NOT NULL AND "dealSetBy" IS NOT NULL AND "dealReason" IS NOT NULL)
  );
