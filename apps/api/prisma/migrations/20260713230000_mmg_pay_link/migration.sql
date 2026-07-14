-- Opt-in MMG (Mobile Money Guyana) "pay me" link per vendor + taxi driver.
-- When set, customers can pay this vendor/driver directly via MMG (money never
-- touches Swift); null = cash-only. Public pay URL, not a secret credential.

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "mmgPayUrl" TEXT;

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "mmgPayUrl" TEXT;
