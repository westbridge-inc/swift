-- A completion is claimed durably before its one financial request. Finance
-- cannot turn a typed reference into authenticated provider evidence.
ALTER TABLE card_sessions ADD COLUMN "completionClaimedAt" TIMESTAMP(3), ADD COLUMN "completionEvidence" JSONB;

CREATE OR REPLACE FUNCTION card_sessions_provider_actions() RETURNS trigger AS $$
BEGIN
  IF OLD."completionClaimedAt" IS NOT NULL AND NEW."completionClaimedAt" IS DISTINCT FROM OLD."completionClaimedAt" THEN
    RAISE EXCEPTION 'card completion claim is written once' USING ERRCODE='check_violation';
  END IF;
  IF OLD."completionEvidence" IS NOT NULL AND NEW."completionEvidence" IS DISTINCT FROM OLD."completionEvidence" THEN
    RAISE EXCEPTION 'card completion evidence is written once' USING ERRCODE='check_violation';
  END IF;
  IF OLD."providerTransactionRef" IS NOT NULL AND NEW."providerTransactionRef" IS DISTINCT FROM OLD."providerTransactionRef" THEN
    RAISE EXCEPTION 'card_sessions row %: the provider transaction reference is written once [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."providerVoidState" IS DISTINCT FROM OLD."providerVoidState" AND NOT (
       (OLD."providerVoidState" IS NULL AND NEW."providerVoidState" = 'SENDING')
    OR (OLD."providerVoidState" = 'SENDING' AND NEW."providerVoidState" IN ('VOIDED', 'FAILED', 'UNKNOWN'))
  ) THEN
    RAISE EXCEPTION 'card_sessions row %: a void claim only moves forward (% -> %) [PT-4]', OLD.id, OLD."providerVoidState", NEW."providerVoidState" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."providerRefundState" IS DISTINCT FROM OLD."providerRefundState" AND NOT (
       (OLD."providerRefundState" IS NULL AND NEW."providerRefundState" = 'SENDING')
    OR (OLD."providerRefundState" IN ('SENDING', 'PENDING') AND NEW."providerRefundState" IN ('PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN'))
  ) THEN
    RAISE EXCEPTION 'card_sessions row %: a refund claim only moves forward (% -> %) [PT-4]', OLD.id, OLD."providerRefundState", NEW."providerRefundState" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."bookClaimedAt" IS NOT NULL AND NEW."bookClaimedAt" IS DISTINCT FROM OLD."bookClaimedAt" THEN
    RAISE EXCEPTION 'card_sessions row %: a booking claim is written once [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- [Review S2-2 · one money movement] A session whose money a void or a
  -- refund may have returned is never booked; a session with a payment is
  -- never voided; a booked payment is never refunded here. (A void or refund
  -- the provider REFUSED moved nothing, so it does not count.)
  IF OLD."providerVoidState" IS NULL AND NEW."providerVoidState" IS NOT NULL AND NEW."paymentId" IS NOT NULL THEN
    RAISE EXCEPTION 'card_sessions row %: a session with a payment is never voided [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."paymentId" IS NULL AND NEW."paymentId" IS NOT NULL
     AND NEW."providerVoidState" IS NOT NULL AND NEW."providerVoidState" <> 'FAILED' THEN
    RAISE EXCEPTION 'card_sessions row %: a session whose void may have taken effect never takes a payment [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF ((OLD."bookClaimedAt" IS NULL AND NEW."bookClaimedAt" IS NOT NULL) OR (OLD."status" <> 'SUCCEEDED' AND NEW."status" = 'SUCCEEDED'))
     AND ((NEW."providerVoidState" IS NOT NULL AND NEW."providerVoidState" <> 'FAILED')
       OR (NEW."providerRefundState" IS NOT NULL AND NEW."providerRefundState" <> 'FAILED')) THEN
    RAISE EXCEPTION 'card_sessions row %: a payment a void or refund may have returned is never booked [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."providerRefundState" IS NULL AND NEW."providerRefundState" IS NOT NULL
     AND (OLD."status" = 'SUCCEEDED'
       OR EXISTS (SELECT 1 FROM "subscription_payments" p WHERE p."id" = NEW."paymentId" AND p."status" = 'CAPTURED')
       OR EXISTS (SELECT 1 FROM "billing_events" e WHERE e."idempotencyKey" = 'bank:' || NEW."paymentId")) THEN
    RAISE EXCEPTION 'card_sessions row %: a booked payment is never refunded here [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."resolution" IS NOT NULL AND (NEW."resolution" IS DISTINCT FROM OLD."resolution"
       OR NEW."resolvedBy" IS DISTINCT FROM OLD."resolvedBy" OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt") THEN
    RAISE EXCEPTION 'card_sessions row %: a finance resolution is written once [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION card_sessions_frozen() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
           OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
           OR NEW."userId" IS DISTINCT FROM OLD."userId"
           OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
           OR NEW."provider" IS DISTINCT FROM OLD."provider"
           OR NEW."environment" IS DISTINCT FROM OLD."environment"
           OR NEW."providerAccount" IS DISTINCT FROM OLD."providerAccount"
           OR NEW."amount" IS DISTINCT FROM OLD."amount"
           OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
           OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
           OR NEW."stateHash" IS DISTINCT FROM OLD."stateHash"
           OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
           OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
           OR NEW."consentVersion" IS DISTINCT FROM OLD."consentVersion"
           OR NEW."consentAt" IS DISTINCT FROM OLD."consentAt"
           OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
          RAISE EXCEPTION 'card_sessions row % is bound: payer, subscription, purpose, binding, price, state and window never change [PT-1 C8]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF (OLD."returnedAt" IS NOT NULL AND NEW."returnedAt" IS DISTINCT FROM OLD."returnedAt")
           OR (OLD."confirmedAt" IS NOT NULL AND NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt")
           OR (OLD."instrumentId" IS NOT NULL AND NEW."instrumentId" IS DISTINCT FROM OLD."instrumentId")
           OR (OLD."paymentId" IS NOT NULL AND NEW."paymentId" IS DISTINCT FROM OLD."paymentId")
           OR (OLD."providerSessionRef" IS NOT NULL AND NEW."providerSessionRef" IS DISTINCT FROM OLD."providerSessionRef")
           OR (OLD."hostedUrl" IS NOT NULL AND NEW."hostedUrl" IS DISTINCT FROM OLD."hostedUrl") THEN
          RAISE EXCEPTION 'card_sessions row %: a one-use marker is written once and never rewritten or cleared [PT-1 C8]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF OLD."status" IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED') AND NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
          OLD."status" IN ('FAILED', 'EXPIRED', 'CANCELLED') AND NEW."status"='HELD'
          AND NEW."purpose"='PAY_NOW' AND NEW."paymentId" IS NULL AND NEW."resolution" IS NULL
          AND NEW."providerVoidState"='SENDING' AND NEW."failureCode"='LATE_PROVIDER_APPROVAL'
        ) THEN
          RAISE EXCEPTION 'card_sessions row % is %: a terminal session never changes status [PT-1]',
            OLD.id, OLD."status" USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

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
