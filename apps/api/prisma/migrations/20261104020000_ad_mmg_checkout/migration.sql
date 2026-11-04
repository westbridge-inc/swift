-- [ADS-ON · owner ruling 22:32Z 3 Nov] Advertisers pay through the MMG checkout page, paid only after MMG's own
-- lookup confirms. An ad invoice becomes a third payer of the checkout the weekly fee already uses, so the same
-- reply, lookup and six conditions decide it. EXPAND only: every existing checkout keeps its payer, and nothing here
-- changes an existing row.
--
-- FORWARD
--  1. mmg_checkout_intents."adInvoiceId", in the payer shape (CHECK: exactly one of the three payers).
--  2. One OPEN or CONFIRMING checkout per invoice.
--  3. A checkout is born from its invoice: same tenant, same whole amount, same currency, the invoice still unpaid.
--  4. The payer is added to the fields that may never change under a confirmation hold.
--
-- ROLLBACK: rollback.sql beside this file (forward repair is preferred). The guard refuses once any ad checkout
-- exists: its MMG page and any payment on it are money evidence.

SET lock_timeout = '10s';

ALTER TABLE "mmg_checkout_intents" ADD COLUMN "adInvoiceId" TEXT;
ALTER TABLE "mmg_checkout_intents" DROP CONSTRAINT "mmg_checkout_intents_payer_shape";
ALTER TABLE "mmg_checkout_intents" ADD CONSTRAINT "mmg_checkout_intents_payer_shape"
  CHECK (num_nonnulls("subscriptionId", "chainOwnerId", "adInvoiceId") = 1);
CREATE INDEX "mmg_checkout_intents_adInvoiceId_createdAt_idx" ON "mmg_checkout_intents"("adInvoiceId", "createdAt");
CREATE UNIQUE INDEX "mmg_checkout_intents_one_open_per_ad_invoice"
  ON "mmg_checkout_intents"("adInvoiceId") WHERE "status" IN ('OPEN', 'CONFIRMING');
ALTER TABLE "mmg_checkout_intents" ADD CONSTRAINT "mmg_checkout_intents_adInvoiceId_fkey"
  FOREIGN KEY ("adInvoiceId") REFERENCES "ad_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION mmg_ad_checkout_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i ad_invoices%ROWTYPE;
BEGIN
  SELECT * INTO i FROM ad_invoices WHERE id = NEW."adInvoiceId";
  IF i.id IS NULL OR i."tenantId" <> NEW."tenantId" OR i.status <> 'UNPAID' OR i.amount <> NEW.amount
    OR NEW.amount <> trunc(NEW.amount) OR i.currency <> NEW."currencyCode" OR NEW.status <> 'OPEN' THEN
    RAISE EXCEPTION 'An ad checkout is born from its unpaid invoice' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mmg_ad_checkout_lineage BEFORE INSERT ON "mmg_checkout_intents"
  FOR EACH ROW WHEN (NEW."adInvoiceId" IS NOT NULL) EXECUTE FUNCTION mmg_ad_checkout_lineage();

CREATE OR REPLACE FUNCTION billing_confirmation_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='subscription_payments' THEN
    IF ((NEW."subscriptionId",NEW."paymentMethod",NEW.amount,NEW."periodStart",NEW."periodEnd") IS DISTINCT FROM
      (OLD."subscriptionId",OLD."paymentMethod",OLD.amount,OLD."periodStart",OLD."periodEnd")
      -- The only key change: a card charge proven never sent releases its attempt key.
      OR (NEW."clientKey" IS DISTINCT FROM OLD."clientKey" AND NOT COALESCE(OLD."paymentMethod"='CARD'
        AND OLD."externalRef" IS NULL AND NEW."externalRef" IS NULL AND NEW.status='EXPIRED'
        AND NEW."failureCode" IS NOT DISTINCT FROM 'DISPATCH_REVOKED' AND OLD."clientKey" IS NOT NULL
        AND NEW."clientKey" IS NOT DISTINCT FROM OLD."clientKey"||':void:'||OLD.id, false))
      OR (OLD."paymentMethod"='MOBILE_MONEY' AND OLD."externalRef" IS NOT NULL AND NEW."externalRef" IS DISTINCT FROM OLD."externalRef")
      OR (OLD."paidAt" IS NOT NULL AND NEW."paidAt" IS DISTINCT FROM OLD."paidAt")) AND EXISTS (SELECT 1 FROM payment_confirmation_holds WHERE "paymentId"=OLD.id) THEN
      RAISE EXCEPTION 'Confirmation source ownership is immutable' USING ERRCODE='check_violation';
    END IF;
  ELSIF TG_TABLE_NAME='mmg_checkout_intents' THEN
    -- [ADS-ON] An ad checkout has no hold, so its own row is what must never change hands.
    IF (NEW."adInvoiceId",NEW.amount,NEW."currencyCode",NEW."tenantId",NEW."createdByUserId") IS DISTINCT FROM
      (OLD."adInvoiceId",OLD.amount,OLD."currencyCode",OLD."tenantId",OLD."createdByUserId")
      AND OLD."adInvoiceId" IS NOT NULL THEN
      RAISE EXCEPTION 'Confirmation source ownership is immutable' USING ERRCODE='check_violation';
    END IF;
    IF (NEW."subscriptionId",NEW."chainOwnerId",NEW."adInvoiceId",NEW."tenantId",NEW."createdByUserId",NEW.amount,NEW."currencyCode") IS DISTINCT FROM
      (OLD."subscriptionId",OLD."chainOwnerId",OLD."adInvoiceId",OLD."tenantId",OLD."createdByUserId",OLD.amount,OLD."currencyCode")
      AND (EXISTS (SELECT 1 FROM payment_confirmation_holds WHERE "checkoutId"=OLD.id)
        -- [ENTERPRISE E1] A chain checkout's branches hold through their parts.
        OR EXISTS (SELECT 1 FROM payment_confirmation_holds h JOIN mmg_checkout_parts part ON part.id=h."checkoutPartId" WHERE part."checkoutId"=OLD.id)) THEN
      RAISE EXCEPTION 'Confirmation source ownership is immutable' USING ERRCODE='check_violation';
    END IF;
  ELSE
    IF (NEW."subscriptionId",NEW."tenantId",NEW."userId",NEW.purpose,NEW.amount,NEW."currencyCode") IS DISTINCT FROM
      (OLD."subscriptionId",OLD."tenantId",OLD."userId",OLD.purpose,OLD.amount,OLD."currencyCode")
      AND EXISTS (SELECT 1 FROM payment_confirmation_holds WHERE "cardSessionId"=OLD.id) THEN
      RAISE EXCEPTION 'Confirmation source ownership is immutable' USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
