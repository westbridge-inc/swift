-- [Owner ruling 2026-10-07] Unused prepaid weekly-fee credit is refunded before
-- an account can be deleted. Swift never moves the money: an admin pays it back
-- outside Swift (MMG or bank transfer). Every step is approved by two admins:
--   1. SET ASIDE  - the whole credit leaves the wallet into REFUND_PAYABLE
--                   (PREPAID_REFUND_RESERVED). Nothing is paid before this.
--   2. PAID       - the set-aside is paid outside Swift and its transfer
--                   reference recorded once (PREPAID_REFUND).
--   3. RELEASED   - a set-aside that could not be paid returns to the wallet
--                   (PREPAID_REFUND_RELEASED).
-- Each step posts a balanced ledger movement in the same transaction.
--
-- FORWARD: three enum values and one chart-of-accounts row. No existing row
-- changes.
--
-- ROLLBACK (honest scope). PostgreSQL cannot drop a value from an enum without
-- rebuilding the type, so a rollback leaves the three values in
-- "BillingEventType" (inert while no row uses them), and the REFUND_PAYABLE
-- account row stays (ledger rows reference it; the ledger is append-only).
-- PRECONDITION for running the previous application: no billing_events row may
-- carry any of the three values, because the previous Prisma client cannot read
-- them.
ALTER TYPE "BillingEventType" ADD VALUE IF NOT EXISTS 'PREPAID_REFUND_RESERVED';
ALTER TYPE "BillingEventType" ADD VALUE IF NOT EXISTS 'PREPAID_REFUND';
ALTER TYPE "BillingEventType" ADD VALUE IF NOT EXISTS 'PREPAID_REFUND_RELEASED';

-- Chart of accounts (reporting mirror; modules/billing/ledger.ts is truth).
INSERT INTO "ledger_accounts" ("code", "name", "type") VALUES
  ('REFUND_PAYABLE', 'Fee credit set aside for a refund, not yet paid back (subledger = subscriptionId)', 'LIABILITY')
ON CONFLICT ("code") DO NOTHING;
