-- PostgreSQL numeric NaN compares above ordinary numbers and equals its own
-- truncation. Exclude it explicitly from all door-cash monetary attestations.
-- Existing nullable legacy records remain valid. No amount is rewritten.
SET lock_timeout = '10s';
ALTER TABLE "orders" ADD CONSTRAINT "orders_door_cash_finite"
  CHECK (("doorCashCollectedAmount" IS NULL OR "doorCashCollectedAmount" <> 'NaN'::numeric)
    AND ("doorCashShortfallAmount" IS NULL OR "doorCashShortfallAmount" <> 'NaN'::numeric)
    AND ("doorCashReturnAmount" IS NULL OR "doorCashReturnAmount" <> 'NaN'::numeric)) NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_door_cash_finite";
