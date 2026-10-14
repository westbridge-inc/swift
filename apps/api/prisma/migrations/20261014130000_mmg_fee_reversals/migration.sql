-- [MMG REVERSAL · owner decision #11, 13 Oct 2026] Returning a WHOLE weekly-fee
-- payment to the partner's MMG account.
--
-- MMG reverses a payment in full only. A reversal is a money (C4) admin action
-- (two people, or the owner in solo mode). This table is its durable claim,
-- written BEFORE MMG is asked, so a crash or a lost answer can never lose the
-- fact that the question went out. The fee wallet is debited exactly once
-- (one PREPAID_REVERSAL event, its unique key), and only after MMG's own
-- lookup proves the reversal. A lost or unclear answer is HELD for a person.
--
-- One live reversal per payment (a partial unique index: a refused attempt,
-- FAILED, frees the payment for another). States move forward only (trigger),
-- the identity of what is being reversed is written once, and a debited
-- wallet can only belong to a REVERSED row.
SET lock_timeout = '10s';

-- AlterEnum (the new value is not used in this migration)
ALTER TYPE "BillingEventType" ADD VALUE IF NOT EXISTS 'PREPAID_REVERSAL';

-- CreateTable
CREATE TABLE "mmg_fee_reversals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "mmgTransactionId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currencyCode" CHAR(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'SENDING',
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "approvalId" TEXT,
    "providerStatus" TEXT,
    "providerReason" TEXT,
    "providerReference" TEXT,
    "lookupStatus" TEXT,
    "heldReason" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "walletDebitedAt" TIMESTAMP(3),
    "billingEventId" TEXT,
    "failedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mmg_fee_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mmg_fee_reversals_billingEventId_key" ON "mmg_fee_reversals"("billingEventId");

-- CreateIndex
CREATE INDEX "mmg_fee_reversals_tenantId_idx" ON "mmg_fee_reversals"("tenantId");

-- CreateIndex
CREATE INDEX "mmg_fee_reversals_subscriptionId_state_idx" ON "mmg_fee_reversals"("subscriptionId", "state");

-- CreateIndex
CREATE INDEX "mmg_fee_reversals_checkoutId_idx" ON "mmg_fee_reversals"("checkoutId");

-- AddForeignKey
ALTER TABLE "mmg_fee_reversals" ADD CONSTRAINT "mmg_fee_reversals_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "mmg_checkout_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One live reversal per payment. A FAILED attempt (MMG refused, the payment
-- stands) frees it; REVERSED, in flight or HELD do not.
CREATE UNIQUE INDEX "mmg_fee_reversals_one_live_per_checkout"
  ON "mmg_fee_reversals"("checkoutId") WHERE "state" <> 'FAILED';

ALTER TABLE "mmg_fee_reversals"
  ADD CONSTRAINT "mmg_fee_reversals_state_check"
    CHECK ("state" IN ('SENDING', 'SENT', 'REVERSED', 'FAILED', 'HELD')),
  ADD CONSTRAINT "mmg_fee_reversals_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "mmg_fee_reversals_reversed_check"
    CHECK ("state" <> 'REVERSED' OR ("reversedAt" IS NOT NULL AND "walletDebitedAt" IS NOT NULL AND "billingEventId" IS NOT NULL)),
  ADD CONSTRAINT "mmg_fee_reversals_debit_only_reversed_check"
    CHECK (("walletDebitedAt" IS NULL AND "billingEventId" IS NULL) OR "state" = 'REVERSED'),
  ADD CONSTRAINT "mmg_fee_reversals_failed_check"
    CHECK ("state" <> 'FAILED' OR "failedAt" IS NOT NULL),
  -- A person's resolution of a HELD return is named, signed and evidenced, and
  -- only ever closes it: NOT_RETURNED -> FAILED, RETURNED_BY_REFERENCE -> REVERSED,
  -- RETURNED_NOT_BOOKED (MMG returned money that had already paid for a week:
  -- nothing deducted, the refund procedure settles it) -> FAILED.
  ADD CONSTRAINT "mmg_fee_reversals_resolution_check"
    CHECK ("resolution" IS NULL OR (
      "resolvedBy" IS NOT NULL AND "resolutionNote" IS NOT NULL AND (
        ("resolution" = 'NOT_RETURNED' AND "state" = 'FAILED')
        OR ("resolution" = 'RETURNED_BY_REFERENCE' AND "state" IN ('HELD', 'REVERSED'))
        OR ("resolution" = 'RETURNED_NOT_BOOKED' AND "state" = 'FAILED')
      )));

-- Forward only. What is being reversed (payer, payment, transaction, amount,
-- reason, who asked, when it was sent) is written once; a state moves
-- SENDING -> SENT | REVERSED | FAILED | HELD, SENT -> REVERSED | FAILED | HELD,
-- HELD -> REVERSED | FAILED; REVERSED and FAILED are final.
CREATE OR REPLACE FUNCTION mmg_fee_reversals_forward() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
     OR NEW."checkoutId" IS DISTINCT FROM OLD."checkoutId"
     OR NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId"
     OR NEW."mmgTransactionId" IS DISTINCT FROM OLD."mmgTransactionId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."requestedBy" IS DISTINCT FROM OLD."requestedBy"
     OR NEW."approvalId" IS DISTINCT FROM OLD."approvalId"
     OR NEW."sentAt" IS DISTINCT FROM OLD."sentAt" THEN
    RAISE EXCEPTION 'mmg_fee_reversals row %: what is being reversed is written once [MMG REVERSAL]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."resolution" IS NOT NULL AND (NEW."resolution" IS DISTINCT FROM OLD."resolution"
        OR NEW."resolvedBy" IS DISTINCT FROM OLD."resolvedBy" OR NEW."resolutionNote" IS DISTINCT FROM OLD."resolutionNote")) THEN
    RAISE EXCEPTION 'mmg_fee_reversals row %: a resolution is written once [MMG REVERSAL]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."walletDebitedAt" IS NOT NULL AND NEW."walletDebitedAt" IS DISTINCT FROM OLD."walletDebitedAt")
     OR (OLD."billingEventId" IS NOT NULL AND NEW."billingEventId" IS DISTINCT FROM OLD."billingEventId")
     OR (OLD."reversedAt" IS NOT NULL AND NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt") THEN
    RAISE EXCEPTION 'mmg_fee_reversals row %: the wallet debit is written once [MMG REVERSAL]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
       (OLD."state" = 'SENDING' AND NEW."state" IN ('SENT', 'REVERSED', 'FAILED', 'HELD'))
    OR (OLD."state" = 'SENT' AND NEW."state" IN ('REVERSED', 'FAILED', 'HELD'))
    OR (OLD."state" = 'HELD' AND NEW."state" IN ('REVERSED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'mmg_fee_reversals row %: a reversal only moves forward (% -> %) [MMG REVERSAL]', OLD.id, OLD."state", NEW."state" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER mmg_fee_reversals_forward BEFORE UPDATE ON "mmg_fee_reversals"
  FOR EACH ROW EXECUTE FUNCTION mmg_fee_reversals_forward();

-- Tenant wall (rlsDdlFor('mmg_fee_reversals'), src/lib/tenant-rls.ts).
ALTER TABLE "mmg_fee_reversals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mmg_fee_reversals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mmg_fee_reversals";
CREATE POLICY "tenant_isolation" ON "mmg_fee_reversals"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
