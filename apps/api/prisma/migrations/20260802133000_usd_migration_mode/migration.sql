-- USD pricing System 2 Part 13: migration mode + Mode-B sunset. Additive.
ALTER TABLE "tenant_billing_currency" ADD COLUMN "usdMigrationMode" TEXT;
ALTER TABLE "tenant_billing_currency" ADD COLUMN "usdSunsetAt" TIMESTAMP(3);
