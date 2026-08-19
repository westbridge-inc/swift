-- Expand-only: preserve the exact direct-payment instruction committed at
-- checkout. Existing MOBILE_MONEY orders remain NULL and therefore fail closed
-- instead of inheriting a vendor's current, mutable profile destination.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "orders"
  ADD COLUMN "mmgPayUrlSnapshot" TEXT,
  ADD COLUMN "mmgRecipientNameSnapshot" TEXT;
