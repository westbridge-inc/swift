-- [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] A store gives Swift its MMG NUMBER (a +592 mobile), not a pay link.
-- A customer who chose MMG sees the number and the exact amount on the order once the store accepts, pays
-- the store directly in MMG, and the store taps "Paid by MMG". Swift never holds or moves the money.
--
-- ADDITIVE ONLY: five nullable columns and one index. Every existing row keeps NULL (no MMG number on file;
-- no order paid to a number). The pay-link columns are untouched and stay dormant.
--  * vendors."mmgNumber": the live number. "mmgNumberPending/PendingAt/ApplyAt": a staged change behind the
--    ALG-34 cool-off (the same rule as the link: the old number keeps paying the store until then).
--  * orders."mmgNumberSnapshot": the number committed at checkout under the vendor row lock.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "vendors" ADD COLUMN "mmgNumber" TEXT;
ALTER TABLE "vendors" ADD COLUMN "mmgNumberPending" TEXT;
ALTER TABLE "vendors" ADD COLUMN "mmgNumberPendingAt" TIMESTAMP(3);
ALTER TABLE "vendors" ADD COLUMN "mmgNumberApplyAt" TIMESTAMP(3);
CREATE INDEX "vendors_mmgNumberApplyAt_idx" ON "vendors"("mmgNumberApplyAt");
ALTER TABLE "orders" ADD COLUMN "mmgNumberSnapshot" TEXT;
