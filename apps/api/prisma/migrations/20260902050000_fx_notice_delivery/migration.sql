-- [M-14] A notice event records when the payer was actually told. Additive:
-- one nullable column and its index. Existing notice events stay null — the
-- charge gate treats them as undelivered and the notice job re-attempts them.
SET lock_timeout = '10s';
ALTER TABLE "billing_events" ADD COLUMN "deliveredAt" TIMESTAMP(3);
CREATE INDEX "billing_events_type_deliveredAt_idx" ON "billing_events"("type", "deliveredAt");
