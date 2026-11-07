-- [ENTERPRISE E1 · owner 29 Oct 2026 "just do whats best"; COORD ruling 21:28Z] "Pay all my branches": a store
-- owner with several branches may pay every branch fee that is due in ONE MMG checkout (optional: each branch's own
-- checkout keeps working). Swift still never holds the money: nothing is credited until MMG's own lookup confirms the
-- exact amount (the six conditions of MMG-CHECKOUT-API.md section 5, unchanged); then the one MMG payment is
-- credited to each branch's weekly fee, branch by branch, in one transaction.
-- EXPAND only: every existing checkout keeps its subscription, and nothing here changes an existing row.
--
-- FORWARD
--  1. mmg_checkout_intents: "subscriptionId" may be NULL for a chain checkout, which names its owner in the new
--     "chainOwnerId" instead (CHECK: exactly one of the two). One OPEN or CONFIRMING chain checkout per owner.
--  2. mmg_checkout_parts: one row per branch a chain checkout pays (the branch's subscription and its whole-GYD
--     share). Written with the checkout, never changed (trigger), only for the owner's own branches (trigger), and
--     the shares add up exactly to the checkout's amount (deferred constraint triggers on both tables).
--  3. payment_confirmation_holds."checkoutPartId": each branch's own hold for its share, so a chain checkout pauses
--     every branch's billing clock exactly as a single-branch checkout pauses its one clock. The source shape
--     admits four sources (exactly one), and the lineage, source-immutability and coverage functions learn parts.
--
-- ROLLBACK: rollback.sql beside this file (forward repair is preferred). The guard refuses once any chain checkout
-- exists: its MMG page, holds and credits are money evidence.

SET lock_timeout = '10s';

-- 1. Chain checkouts --------------------------------------------------------------------------------------------
ALTER TABLE "mmg_checkout_intents" ALTER COLUMN "subscriptionId" DROP NOT NULL;
ALTER TABLE "mmg_checkout_intents" ADD COLUMN "chainOwnerId" TEXT;
ALTER TABLE "mmg_checkout_intents" ADD CONSTRAINT "mmg_checkout_intents_payer_shape"
  CHECK (num_nonnulls("subscriptionId", "chainOwnerId") = 1);
CREATE INDEX "mmg_checkout_intents_chainOwnerId_createdAt_idx" ON "mmg_checkout_intents"("chainOwnerId", "createdAt");
-- [I4 for chains] One open chain checkout per owner (each branch is also covered by its own hold below).
CREATE UNIQUE INDEX "mmg_checkout_intents_one_open_per_chain_owner"
  ON "mmg_checkout_intents"("chainOwnerId") WHERE "status" IN ('OPEN', 'CONFIRMING');
ALTER TABLE "mmg_checkout_intents" ADD CONSTRAINT "mmg_checkout_intents_chainOwnerId_fkey"
  FOREIGN KEY ("chainOwnerId") REFERENCES "vendor_owners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. The branches a chain checkout pays --------------------------------------------------------------------------
CREATE TABLE "mmg_checkout_parts" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL DEFAULT 'swift-default',
    "checkoutId"     TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "amount"         DECIMAL(12,2) NOT NULL,
    "currencyCode"   CHAR(3) NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mmg_checkout_parts_pkey" PRIMARY KEY ("id"),
    -- MMG takes whole dollars, and each branch's share is a whole, positive GYD amount.
    CONSTRAINT "mmg_checkout_parts_amount_check" CHECK ("amount" > 0 AND "amount" = trunc("amount")),
    CONSTRAINT "mmg_checkout_parts_currency_check" CHECK ("currencyCode" = 'GYD')
);
CREATE UNIQUE INDEX "mmg_checkout_parts_checkoutId_subscriptionId_key" ON "mmg_checkout_parts"("checkoutId", "subscriptionId");
CREATE INDEX "mmg_checkout_parts_subscriptionId_createdAt_idx" ON "mmg_checkout_parts"("subscriptionId", "createdAt");
CREATE INDEX "mmg_checkout_parts_tenantId_idx" ON "mmg_checkout_parts"("tenantId");
ALTER TABLE "mmg_checkout_parts" ADD CONSTRAINT "mmg_checkout_parts_checkoutId_fkey"
  FOREIGN KEY ("checkoutId") REFERENCES "mmg_checkout_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mmg_checkout_parts" ADD CONSTRAINT "mmg_checkout_parts_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A part is born with its OPEN chain checkout, under its tenant, for one of the checkout owner's own branches, paid
-- by the person who started the checkout; it never changes afterwards.
CREATE FUNCTION mmg_checkout_parts_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m mmg_checkout_intents%ROWTYPE; payer_user text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A chain checkout part is immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO m FROM mmg_checkout_intents WHERE id = NEW."checkoutId";
  IF m.id IS NULL OR m."chainOwnerId" IS NULL OR m.status <> 'OPEN' OR m."tenantId" <> NEW."tenantId"
    OR m."currencyCode" <> NEW."currencyCode" THEN
    RAISE EXCEPTION 'A part belongs to an open chain checkout of its own tenant and currency' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscriptions s JOIN vendors v ON v.id = s."vendorId"
    WHERE s.id = NEW."subscriptionId" AND v."ownerId" = m."chainOwnerId") THEN
    RAISE EXCEPTION 'A chain checkout pays only its owner''s own branches' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "userId" INTO payer_user FROM billing_clock_payer(NEW."subscriptionId");
  IF payer_user IS DISTINCT FROM m."createdByUserId" THEN
    RAISE EXCEPTION 'A chain checkout is paid by the branches'' owner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mmg_checkout_parts_lineage BEFORE INSERT OR UPDATE ON "mmg_checkout_parts"
  FOR EACH ROW EXECUTE FUNCTION mmg_checkout_parts_lineage();

-- The shares add up exactly to what MMG is asked for, checked when the transaction commits (a checkout is written
-- before its parts), and no part is added to a checkout afterwards without the sum failing.
CREATE FUNCTION mmg_chain_checkout_parts_sum() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; m mmg_checkout_intents%ROWTYPE; total numeric; n integer;
BEGIN
  -- (Two branches, not one CASE: a row of the other table has no such field.)
  IF TG_TABLE_NAME = 'mmg_checkout_parts' THEN target := NEW."checkoutId"; ELSE target := NEW.id; END IF;
  SELECT * INTO m FROM mmg_checkout_intents WHERE id = target;
  IF m.id IS NULL OR m."chainOwnerId" IS NULL THEN
    IF TG_TABLE_NAME = 'mmg_checkout_parts' THEN
      RAISE EXCEPTION 'A part belongs to a chain checkout' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(amount), 0), count(*) INTO total, n FROM mmg_checkout_parts WHERE "checkoutId" = m.id;
  IF n = 0 OR total <> m.amount THEN
    RAISE EXCEPTION 'A chain checkout''s parts must add up to its amount' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER mmg_chain_checkout_parts_sum AFTER INSERT ON "mmg_checkout_parts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mmg_chain_checkout_parts_sum();
CREATE CONSTRAINT TRIGGER mmg_chain_checkout_parts_sum AFTER INSERT OR UPDATE OF amount, "chainOwnerId" ON "mmg_checkout_intents"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."chainOwnerId" IS NOT NULL) EXECUTE FUNCTION mmg_chain_checkout_parts_sum();

ALTER TABLE "mmg_checkout_parts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mmg_checkout_parts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mmg_checkout_parts";
CREATE POLICY "tenant_isolation" ON "mmg_checkout_parts"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
-- Money evidence: the application adds parts and reads them, never changes or removes them.
REVOKE UPDATE, DELETE ON "mmg_checkout_parts" FROM swift_app;

-- 3. Each branch's own confirmation hold ------------------------------------------------------------------------
ALTER TABLE "payment_confirmation_holds" ADD COLUMN "checkoutPartId" TEXT;
CREATE UNIQUE INDEX "payment_confirmation_holds_checkoutPartId_key" ON "payment_confirmation_holds"("checkoutPartId");
ALTER TABLE "payment_confirmation_holds" ADD CONSTRAINT "payment_confirmation_holds_checkoutPartId_fkey"
  FOREIGN KEY ("checkoutPartId") REFERENCES "mmg_checkout_parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE payment_confirmation_holds DROP CONSTRAINT confirmation_source_shape;
ALTER TABLE payment_confirmation_holds ADD CONSTRAINT confirmation_source_shape CHECK (
  num_nonnulls("paymentId","checkoutId","cardSessionId","checkoutPartId")=1 AND "sourceEpoch">0
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
  ELSIF NEW."checkoutPartId" IS NOT NULL THEN
    -- [ENTERPRISE E1] One branch's share of a chain checkout: the branch is the part's, the tenant and the
    -- person who started it are the checkout's.
    SELECT part."subscriptionId",m."tenantId",m."createdByUserId" INTO source_sub,source_tenant,source_user
    FROM mmg_checkout_parts part JOIN mmg_checkout_intents m ON m.id=part."checkoutId"
    WHERE part.id=NEW."checkoutPartId" AND m."chainOwnerId" IS NOT NULL AND part."tenantId"=m."tenantId";
  ELSE
    SELECT "subscriptionId","tenantId","userId" INTO source_sub,source_tenant,source_user FROM card_sessions WHERE id=NEW."cardSessionId" AND purpose='PAY_NOW';
  END IF;
  SELECT "userId" INTO payer_user FROM billing_clock_payer(source_sub);
  IF source_sub IS DISTINCT FROM NEW."subscriptionId" OR source_tenant IS DISTINCT FROM NEW."tenantId"
    OR (source_user IS NOT NULL AND source_user IS DISTINCT FROM payer_user) THEN
    RAISE EXCEPTION 'Confirmation source unavailable' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW."tenantId",NEW."subscriptionId",NEW."clockId",NEW."sourceEpoch",NEW."paymentId",NEW."checkoutId",NEW."cardSessionId",NEW."checkoutPartId",NEW."beganAt")
      IS DISTINCT FROM (OLD."tenantId",OLD."subscriptionId",OLD."clockId",OLD."sourceEpoch",OLD."paymentId",OLD."checkoutId",OLD."cardSessionId",OLD."checkoutPartId",OLD."beganAt") THEN
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
          OR EXISTS (SELECT 1 FROM mmg_checkout_parts part JOIN mmg_checkout_intents m ON m.id=part."checkoutId"
            WHERE part.id=NEW."checkoutPartId" AND m.status='HELD')
          OR EXISTS (SELECT 1 FROM card_sessions s WHERE s.id=NEW."cardSessionId" AND s.status='HELD'
            AND s."failureCode"='LATE_PROVIDER_APPROVAL' AND s."providerVoidState" IS NOT NULL)), false) THEN
        RETURN NEW;
      END IF;
      IF OLD.status<>'PROVEN_UNPAID' OR NEW.status<>'SETTLEMENT_APPLY_PENDING' OR num_nonnulls(NEW."checkoutId",NEW."checkoutPartId")<>1
        OR NEW."sourceEpoch"<>c.epoch OR jsonb_array_length(NEW."resolutionHistory")<>old_length+1
        OR correction->>'status'<>'VERIFIED_POSITIVE_CORRECTION'
        OR NOT (EXISTS (
          SELECT 1 FROM mmg_checkout_intents m JOIN provider_payments p ON p.id=m."providerPaymentId"
          JOIN billing_events e ON e.id=correction->>'creditEventId' AND e."subscriptionId"=m."subscriptionId"
            AND e.type='PREPAID_TOPUP' AND e.amount=m.amount AND e."currencyCode"=m."currencyCode"
          WHERE m.id=NEW."checkoutId" AND m.status='CONFIRMED' AND p.id=correction->>'providerPaymentId'
            AND p.provider='MMG' AND p.status='CREDITED' AND p."tenantId"=NEW."tenantId"
            AND p."subscriptionId"=NEW."subscriptionId" AND p.amount=m.amount AND p."currencyCode"=m."currencyCode"
            AND EXISTS (SELECT 1 FROM unnest(m.candidates||ARRAY[m."mmgTransactionId"]) r WHERE mmg_txn_canon(r)=mmg_txn_canon(p."providerTxnId"))
            AND ((e."idempotencyKey"='mmg-checkout:pp:'||p.id AND p."creditedPaymentId"='mco:'||m.id)
              OR (e."idempotencyKey"='agent-cash:pp:'||p.id AND EXISTS (SELECT 1 FROM mmg_agent_payments a WHERE a.id=p."creditedPaymentId" AND a."providerPaymentId"=p.id))
              OR EXISTS (SELECT 1 FROM topup_commands t WHERE t."billingEventId"=e.id AND 'topup:'||t."adminId"||':'||t."idempotencyKey"=p."creditedPaymentId")))
          -- [ENTERPRISE E1] A branch's share of a chain checkout MMG confirmed: the one credited MMG payment
          -- (no single subscription: it paid several) and this branch's own top-up of exactly its part.
          OR EXISTS (
          SELECT 1 FROM mmg_checkout_parts part JOIN mmg_checkout_intents m ON m.id=part."checkoutId"
          JOIN provider_payments p ON p.id=m."providerPaymentId"
          JOIN billing_events e ON e.id=correction->>'creditEventId' AND e."subscriptionId"=part."subscriptionId"
            AND e.type='PREPAID_TOPUP' AND e.amount=part.amount AND e."currencyCode"=part."currencyCode"
          WHERE part.id=NEW."checkoutPartId" AND part."subscriptionId"=NEW."subscriptionId" AND m."chainOwnerId" IS NOT NULL
            AND m.status='CONFIRMED' AND p.id=correction->>'providerPaymentId'
            AND p.provider='MMG' AND p.status='CREDITED' AND p."tenantId"=NEW."tenantId"
            AND p."subscriptionId" IS NULL AND p.amount=m.amount AND p."currencyCode"=m."currencyCode"
            AND EXISTS (SELECT 1 FROM unnest(m.candidates||ARRAY[m."mmgTransactionId"]) r WHERE mmg_txn_canon(r)=mmg_txn_canon(p."providerTxnId"))
            AND e."idempotencyKey"='mmg-checkout:pp:'||p.id||':'||part.id AND p."creditedPaymentId"='mco:'||m.id)) THEN
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

CREATE OR REPLACE FUNCTION billing_confirmation_missing_coverage() RETURNS bigint LANGUAGE sql STABLE AS $$
  WITH originals AS (
    SELECT s.id,num_nonnulls(s."riderId",s."driverId")>0 AS is_mover,p."userId",p."tenantId",m."userId" AS mapped_payer,a."canonicalSubscriptionId"
    FROM subscriptions s LEFT JOIN LATERAL billing_clock_payer(s.id) p ON true
    LEFT JOIN mover_fee_subscriptions m ON m."subscriptionId"=s.id
    LEFT JOIN mover_fee_authorities a ON a."userId"=m."userId" AND a."tenantId"=m."tenantId"
  ), unresolved AS (
    SELECT 'checkout' kind,c.id,c."subscriptionId" FROM mmg_checkout_intents c WHERE c.status IN ('OPEN','CONFIRMING','HELD','EXPIRED') AND c."subscriptionId" IS NOT NULL
    -- [ENTERPRISE E1] A chain checkout is unresolved for each branch it pays, each through its own part.
    UNION ALL SELECT 'part',part.id,part."subscriptionId" FROM mmg_checkout_parts part JOIN mmg_checkout_intents c ON c.id=part."checkoutId"
      WHERE c.status IN ('OPEN','CONFIRMING','HELD','EXPIRED')
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
        OR (u.kind='card' AND h."cardSessionId"=u.id) OR (u.kind='payment' AND h."paymentId"=u.id)
        OR (u.kind='part' AND h."checkoutPartId"=u.id))))
    + (SELECT count(*) FROM mover_fee_authorities a LEFT JOIN billing_dunning_clocks c ON c."moverPayerUserId"=a."userId"
      WHERE c.id IS NULL OR c."subscriptionId"<>a."canonicalSubscriptionId" OR c."authorityRevision" IS DISTINCT FROM a.revision
        OR (a.state='FINANCE_HOLD' AND (c."pausedAt" IS NULL OR c."authorityHoldReason" IS DISTINCT FROM a."holdReason")))
    + (SELECT count(*) FROM payment_confirmation_holds h JOIN billing_dunning_clocks c ON c.id=h."clockId"
      WHERE h.status IN ('ACTIVE','SETTLEMENT_APPLY_PENDING') AND c."pausedAt" IS NULL)
$$;
