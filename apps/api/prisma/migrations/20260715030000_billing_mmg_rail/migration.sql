-- §13 dual-rail billing: the subscriber's MMG account for merchant-initiated
-- weekly-fee requests (billingMethod MOBILE_MONEY).
ALTER TABLE "subscriptions" ADD COLUMN "mmgPayerMsisdn" TEXT;
