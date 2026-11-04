-- ROLLBACK for 20261104020000_ad_mmg_checkout (advertisers pay through the MMG checkout, 4 Nov 2026).
--
-- Forward repair is preferred. Roll the application back first: the previous application never writes an ad
-- checkout. The guard refuses once any ad checkout exists: its MMG page and any payment on it are money evidence.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "mmg_checkout_intents" WHERE "adInvoiceId" IS NOT NULL) THEN
    RAISE EXCEPTION 'AD_CHECKOUTS_IN_USE: an ad checkout exists; not rolling back';
  END IF;
END $guard$;
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
    IF (NEW."subscriptionId",NEW."chainOwnerId",NEW."tenantId",NEW."createdByUserId",NEW.amount,NEW."currencyCode") IS DISTINCT FROM
      (OLD."subscriptionId",OLD."chainOwnerId",OLD."tenantId",OLD."createdByUserId",OLD.amount,OLD."currencyCode")
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
DROP TRIGGER mmg_ad_checkout_lineage ON "mmg_checkout_intents";
DROP FUNCTION mmg_ad_checkout_lineage();
ALTER TABLE "mmg_checkout_intents" DROP CONSTRAINT "mmg_checkout_intents_adInvoiceId_fkey";
DROP INDEX "mmg_checkout_intents_one_open_per_ad_invoice";
DROP INDEX "mmg_checkout_intents_adInvoiceId_createdAt_idx";
ALTER TABLE "mmg_checkout_intents" DROP CONSTRAINT "mmg_checkout_intents_payer_shape";
ALTER TABLE "mmg_checkout_intents" ADD CONSTRAINT "mmg_checkout_intents_payer_shape"
  CHECK (num_nonnulls("subscriptionId", "chainOwnerId") = 1);
ALTER TABLE "mmg_checkout_intents" DROP COLUMN "adInvoiceId";
DROP SEQUENCE "ad_invoice_number_seq";
COMMIT;
