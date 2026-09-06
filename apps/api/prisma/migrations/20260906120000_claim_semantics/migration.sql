-- [DOC-1 §31.5 · DOC-INV-48 · P31-2] Claim, not fact: the store's "MMG payment received" is CLAIMED, never CAPTURED;
-- the customer's own "I paid" claim and a mismatch hold sit beside it. EXPAND: an enum value and three nullable columns.
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CLAIMED';
ALTER TABLE "orders" ADD COLUMN "customerClaimedPaidAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "customerPaymentRef" TEXT;
ALTER TABLE "orders" ADD COLUMN "mmgClaimMismatchAt" TIMESTAMP(3);
