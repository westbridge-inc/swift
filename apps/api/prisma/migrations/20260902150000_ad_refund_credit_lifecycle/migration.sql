-- [R045-ADS-01/02/03/08/09] The modeled ad-refund intent is now the runtime:
-- a CREDIT item moves the advertiser's credit balance exactly once
-- (the intent's execution record — items are immutable), and the balance is an explicit liability column. Additive.
SET lock_timeout = '10s';
ALTER TABLE "advertisers" ADD COLUMN "creditBalance" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "advertisers" ADD CONSTRAINT "advertisers_credit_nonnegative_check" CHECK ("creditBalance" >= 0);
