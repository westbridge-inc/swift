-- ROLLBACK for 20261029070000_chain_pay_all ("pay all my branches", ENTERPRISE E1, 29 Oct 2026).
--
-- Forward repair is preferred. Roll the application back first: the previous application never writes a chain
-- checkout. The guard refuses once any chain checkout exists: its MMG page, its branches' holds and credits are money
-- evidence. The functions are restored to their previous text (the migrations that last defined them).
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "mmg_checkout_intents" WHERE "chainOwnerId" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "mmg_checkout_parts")
    OR EXISTS (SELECT 1 FROM "payment_confirmation_holds" WHERE "checkoutPartId" IS NOT NULL) THEN
    RAISE EXCEPTION 'CHAIN_CHECKOUTS_IN_USE: a chain checkout exists; not rolling back';
  END IF;
END $guard$;
ALTER TABLE payment_confirmation_holds DROP CONSTRAINT confirmation_source_shape;
ALTER TABLE payment_confirmation_holds ADD CONSTRAINT confirmation_source_shape CHECK (
  num_nonnulls("paymentId","checkoutId","cardSessionId")=1 AND "sourceEpoch">0
  AND length(reason)>0 AND "reviewDueAt">="beganAt" AND jsonb_typeof("resolutionHistory")='array'
  AND ((status IN ('ACTIVE','SETTLEMENT_APPLY_PENDING') AND "resolvedAt" IS NULL AND "resolvedBy" IS NULL AND "resolutionEvidence" IS NULL)
    OR (status IN ('PAID','PROVEN_UNPAID','PROVEN_NO_EFFECT') AND "resolvedAt" IS NOT NULL
      AND length(btrim("resolvedBy"))>0 AND length(btrim("resolutionEvidence"))>0)));
CREATE OR REPLACE FUNCTION billing_confirmation_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c billing_dunning_clocks%ROWTYPE; source_sub text; source_tenant text; source_user text; payer_user text;
  old_length integer; prefix jsonb; correction jsonb;
BEGIN
  SELECT * INTO c FROM billing_dunning_clocks WHERE id=NEW."clockId";
  IF c.id IS NULL OR c."tenantId"<>NEW."tenantId" OR NEW."sourceEpoch">c.epoch
    OR NOT billing_clock_source_matches(c.id,NEW."subscriptionId") THEN
    RAISE EXCEPTION 'Confirmation ownership unavailable' USING ERRCODE='check_violation';
  END IF;
  IF NEW."paymentId" IS NOT NULL THEN
    SELECT p."subscriptionId" INTO source_sub FROM subscription_payments p WHERE p.id=NEW."paymentId"
      AND p."paymentMethod" IN ('CARD','MOBILE_MONEY') AND COALESCE(p."clientKey",'') NOT LIKE 'cardpay:%'
      AND NOT EXISTS (SELECT 1 FROM card_sessions cs WHERE cs."paymentId"=p.id);
    SELECT "tenantId" INTO source_tenant FROM billing_clock_payer(source_sub);
  ELSIF NEW."checkoutId" IS NOT NULL THEN
    SELECT "subscriptionId","tenantId","createdByUserId" INTO source_sub,source_tenant,source_user FROM mmg_checkout_intents WHERE id=NEW."checkoutId";
  ELSE
    SELECT "subscriptionId","tenantId","userId" INTO source_sub,source_tenant,source_user FROM card_sessions WHERE id=NEW."cardSessionId" AND purpose='PAY_NOW';
  END IF;
  SELECT "userId" INTO payer_user FROM billing_clock_payer(source_sub);
  IF source_sub IS DISTINCT FROM NEW."subscriptionId" OR source_tenant IS DISTINCT FROM NEW."tenantId"
    OR (source_user IS NOT NULL AND source_user IS DISTINCT FROM payer_user) THEN
    RAISE EXCEPTION 'Confirmation source unavailable' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW."tenantId",NEW."subscriptionId",NEW."clockId",NEW."sourceEpoch",NEW."paymentId",NEW."checkoutId",NEW."cardSessionId",NEW."beganAt")
      IS DISTINCT FROM (OLD."tenantId",OLD."subscriptionId",OLD."clockId",OLD."sourceEpoch",OLD."paymentId",OLD."checkoutId",OLD."cardSessionId",OLD."beganAt") THEN
      RAISE EXCEPTION 'Confirmation source identity is immutable' USING ERRCODE='check_violation';
    END IF;
    old_length:=jsonb_array_length(OLD."resolutionHistory");
    SELECT COALESCE(jsonb_agg(value ORDER BY ord),'[]'::jsonb) INTO prefix FROM jsonb_array_elements(NEW."resolutionHistory") WITH ORDINALITY e(value,ord) WHERE ord<=old_length;
    IF prefix<>OLD."resolutionHistory" OR jsonb_array_length(NEW."resolutionHistory") NOT BETWEEN old_length AND old_length+1 THEN
      RAISE EXCEPTION 'Confirmation resolution history is append only' USING ERRCODE='check_violation';
    END IF;
    IF OLD.status NOT IN ('ACTIVE','SETTLEMENT_APPLY_PENDING') AND NEW IS DISTINCT FROM OLD THEN
      correction:=NEW."resolutionHistory"->-1;
      -- A later MMG record that may be money for a checkout an MMG negative had
      -- released reopens the pause for a person, for the same obligation only.
      IF COALESCE(OLD.status='PROVEN_UNPAID' AND NEW.status='ACTIVE'
        AND NEW."sourceEpoch"=c.epoch AND jsonb_array_length(NEW."resolutionHistory")=old_length+1
        AND correction->>'status'='LATE_POSITIVE_REVIEW'
        AND (EXISTS (SELECT 1 FROM mmg_checkout_intents m WHERE m.id=NEW."checkoutId" AND m.status='HELD')
          OR EXISTS (SELECT 1 FROM card_sessions s WHERE s.id=NEW."cardSessionId" AND s.status='HELD'
            AND s."failureCode"='LATE_PROVIDER_APPROVAL' AND s."providerVoidState" IS NOT NULL)), false) THEN
        RETURN NEW;
      END IF;
      IF OLD.status<>'PROVEN_UNPAID' OR NEW.status<>'SETTLEMENT_APPLY_PENDING' OR NEW."checkoutId" IS NULL
        OR NEW."sourceEpoch"<>c.epoch OR jsonb_array_length(NEW."resolutionHistory")<>old_length+1
        OR correction->>'status'<>'VERIFIED_POSITIVE_CORRECTION'
        OR NOT EXISTS (
          SELECT 1 FROM mmg_checkout_intents m JOIN provider_payments p ON p.id=m."providerPaymentId"
          JOIN billing_events e ON e.id=correction->>'creditEventId' AND e."subscriptionId"=m."subscriptionId"
            AND e.type='PREPAID_TOPUP' AND e.amount=m.amount AND e."currencyCode"=m."currencyCode"
          WHERE m.id=NEW."checkoutId" AND m.status='CONFIRMED' AND p.id=correction->>'providerPaymentId'
            AND p.provider='MMG' AND p.status='CREDITED' AND p."tenantId"=NEW."tenantId"
            AND p."subscriptionId"=NEW."subscriptionId" AND p.amount=m.amount AND p."currencyCode"=m."currencyCode"
            AND EXISTS (SELECT 1 FROM unnest(m.candidates||ARRAY[m."mmgTransactionId"]) r WHERE mmg_txn_canon(r)=mmg_txn_canon(p."providerTxnId"))
            AND ((e."idempotencyKey"='mmg-checkout:pp:'||p.id AND p."creditedPaymentId"='mco:'||m.id)
              OR (e."idempotencyKey"='agent-cash:pp:'||p.id AND EXISTS (SELECT 1 FROM mmg_agent_payments a WHERE a.id=p."creditedPaymentId" AND a."providerPaymentId"=p.id))
              OR EXISTS (SELECT 1 FROM topup_commands t WHERE t."billingEventId"=e.id AND 'topup:'||t."adminId"||':'||t."idempotencyKey"=p."creditedPaymentId"))) THEN
        RAISE EXCEPTION 'Resolved confirmation requires exact verified positive correction' USING ERRCODE='check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

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
    IF (NEW."subscriptionId",NEW."tenantId",NEW."createdByUserId",NEW.amount,NEW."currencyCode") IS DISTINCT FROM
      (OLD."subscriptionId",OLD."tenantId",OLD."createdByUserId",OLD.amount,OLD."currencyCode")
      AND EXISTS (SELECT 1 FROM payment_confirmation_holds WHERE "checkoutId"=OLD.id) THEN
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

CREATE OR REPLACE FUNCTION billing_confirmation_missing_coverage() RETURNS bigint LANGUAGE sql STABLE AS $$
  WITH originals AS (
    SELECT s.id,num_nonnulls(s."riderId",s."driverId")>0 AS is_mover,p."userId",p."tenantId",m."userId" AS mapped_payer,a."canonicalSubscriptionId"
    FROM subscriptions s LEFT JOIN LATERAL billing_clock_payer(s.id) p ON true
    LEFT JOIN mover_fee_subscriptions m ON m."subscriptionId"=s.id
    LEFT JOIN mover_fee_authorities a ON a."userId"=m."userId" AND a."tenantId"=m."tenantId"
  ), unresolved AS (
    SELECT 'checkout' kind,c.id,c."subscriptionId" FROM mmg_checkout_intents c WHERE c.status IN ('OPEN','CONFIRMING','HELD','EXPIRED')
    UNION ALL SELECT 'card',c.id,c."subscriptionId" FROM card_sessions c WHERE c.purpose='PAY_NOW' AND (c.status IN ('OPEN','UNKNOWN','HELD') OR (c.status='EXPIRED' AND c."failureCode" IS DISTINCT FROM 'PROVIDER_PAGE_UNAVAILABLE'))
    UNION ALL SELECT 'payment',p.id,p."subscriptionId" FROM subscription_payments p WHERE p."paymentMethod" IN ('CARD','MOBILE_MONEY')
      AND (p.status IN ('UNKNOWN','PENDING') OR (p."paymentMethod"='MOBILE_MONEY' AND p.status IN ('FAILED','EXPIRED')) OR p."failureCode" IN ('REQUIRES_ACTION','AMOUNT_MISMATCH','SETTLEMENT_MISMATCH','HISTORY_APPROVAL_UNVERIFIED','CURRENCY_UNPINNED','WALLET_CURRENCY_MISMATCH','PROVIDER_NOT_FOUND'))
      AND COALESCE(p."failureRaw"->>'providerEffect','')<>'NOT_SENT' AND COALESCE(p."clientKey",'') NOT LIKE 'cardpay:%'
      AND NOT EXISTS (SELECT 1 FROM card_sessions c WHERE c."paymentId"=p.id)
  )
  SELECT (SELECT count(*) FROM originals o LEFT JOIN billing_dunning_clocks c ON c."subscriptionId"=CASE WHEN NOT o.is_mover THEN o.id ELSE o."canonicalSubscriptionId" END
    WHERE o."userId" IS NULL OR c.id IS NULL OR c."tenantId" IS DISTINCT FROM o."tenantId"
      OR (o.is_mover AND (o.mapped_payer IS DISTINCT FROM o."userId" OR c."moverPayerUserId" IS DISTINCT FROM o."userId")))
    + (SELECT count(*) FROM unresolved u WHERE NOT EXISTS (SELECT 1 FROM payment_confirmation_holds h
      WHERE h."subscriptionId"=u."subscriptionId" AND ((u.kind='checkout' AND h."checkoutId"=u.id)
        OR (u.kind='card' AND h."cardSessionId"=u.id) OR (u.kind='payment' AND h."paymentId"=u.id))))
    + (SELECT count(*) FROM mover_fee_authorities a LEFT JOIN billing_dunning_clocks c ON c."moverPayerUserId"=a."userId"
      WHERE c.id IS NULL OR c."subscriptionId"<>a."canonicalSubscriptionId" OR c."authorityRevision" IS DISTINCT FROM a.revision
        OR (a.state='FINANCE_HOLD' AND (c."pausedAt" IS NULL OR c."authorityHoldReason" IS DISTINCT FROM a."holdReason")))
    + (SELECT count(*) FROM payment_confirmation_holds h JOIN billing_dunning_clocks c ON c.id=h."clockId"
      WHERE h.status IN ('ACTIVE','SETTLEMENT_APPLY_PENDING') AND c."pausedAt" IS NULL)
$$;
ALTER TABLE "payment_confirmation_holds" DROP CONSTRAINT "payment_confirmation_holds_checkoutPartId_fkey";
DROP INDEX "payment_confirmation_holds_checkoutPartId_key";
ALTER TABLE "payment_confirmation_holds" DROP COLUMN "checkoutPartId";
DROP TRIGGER mmg_chain_checkout_parts_sum ON "mmg_checkout_intents";
DROP TABLE "mmg_checkout_parts";
DROP FUNCTION mmg_chain_checkout_parts_sum();
DROP FUNCTION mmg_checkout_parts_lineage();
ALTER TABLE "mmg_checkout_intents" DROP CONSTRAINT "mmg_checkout_intents_chainOwnerId_fkey";
DROP INDEX "mmg_checkout_intents_one_open_per_chain_owner";
DROP INDEX "mmg_checkout_intents_chainOwnerId_createdAt_idx";
ALTER TABLE "mmg_checkout_intents" DROP CONSTRAINT "mmg_checkout_intents_payer_shape";
ALTER TABLE "mmg_checkout_intents" DROP COLUMN "chainOwnerId";
ALTER TABLE "mmg_checkout_intents" ALTER COLUMN "subscriptionId" SET NOT NULL;
DO $ledger$
DECLARE n integer;
BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029070000_chain_pay_all';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
