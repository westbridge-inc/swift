-- [BILLING-REANCHOR] Guarded rollback. A return re-anchor is billing evidence
-- (the weeks a returning partner was not billed for); the column and kind go
-- only when no such transition was ever recorded.
-- billing_obligation_transitions forces row-level security, so a role that sees
-- only some rows could find none and pass the guard. Row security is switched
-- off for this transaction: a role that does not bypass it is refused with an
-- error instead. Run this as a role that bypasses row-level security.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing_obligation_transitions WHERE kind='RETURN_REANCHOR' OR "suspensionEventId" IS NOT NULL OR "paymentId" IS NULL OR "successEventId" IS NULL) THEN
    RAISE EXCEPTION 'RETURN_REANCHOR_IN_USE: return re-anchors were recorded; their record is kept, not rolling back';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION billing_obligation_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c billing_dunning_clocks%ROWTYPE; s subscriptions%ROWTYPE; p subscription_payments%ROWTYPE;
  e billing_events%ROWTYPE; lapse billing_events%ROWTYPE; a audit_logs%ROWTYPE; paid billing_obligation_transitions%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Billing obligation transition is immutable' USING ERRCODE='check_violation'; END IF;
  SELECT * INTO c FROM billing_dunning_clocks WHERE id=NEW."clockId" FOR UPDATE;
  SELECT * INTO s FROM subscriptions WHERE id=NEW."subscriptionId";
  SELECT * INTO p FROM subscription_payments WHERE id=NEW."paymentId";
  SELECT * INTO e FROM billing_events WHERE id=NEW."successEventId";
  SELECT * INTO a FROM audit_logs WHERE id=NEW."auditId";
  IF c.id IS NULL OR s.id IS NULL OR p.id IS NULL OR e.id IS NULL OR a.id IS NULL
    OR (c."tenantId",c."subscriptionId",c.epoch,c."dueAt") IS DISTINCT FROM
      (NEW."tenantId",NEW."fromSubscriptionId",NEW."fromEpoch",NEW."fromDue")
    OR NOT billing_clock_source_matches(c.id,s.id)
    OR p."subscriptionId"<>s.id OR p.status<>'CAPTURED' OR p."paidAt" IS NULL OR p."externalRef" IS NULL
    OR (p.amount,p."periodStart",p."periodEnd",e."currencyCode") IS DISTINCT FROM (NEW.amount,NEW."periodStart",NEW."periodEnd",NEW."currencyCode")
    OR (e."subscriptionId",e.type::text,e.amount,e."paymentRef",e."idempotencyKey") IS DISTINCT FROM
      (s.id,'CHARGE_SUCCESS',p.amount,p."externalRef",'success:'||s.id||':'||to_char(p."periodStart",'YYYY-MM-DD'))
    -- The settled currency is the subscription currency or the exact issue pin of
    -- this payment: its hosted card session or its charge attempt record.
    OR NOT (COALESCE(NEW."currencyCode"=s."currencyCode",false)
      OR EXISTS (SELECT 1 FROM card_sessions cs WHERE p."clientKey"='cardpay:'||cs.id AND cs."paymentId"=p.id
        AND cs."subscriptionId"=s.id AND cs."currencyCode"=NEW."currencyCode")
      OR EXISTS (SELECT 1 FROM billing_events att WHERE att."subscriptionId"=s.id AND att.type='CHARGE_ATTEMPT'
        AND att."currencyCode"=NEW."currencyCode" AND ((p."clientKey" LIKE 'sub:%' AND att."idempotencyKey"='charge:'||substr(p."clientKey",5))
          OR (p."clientKey" LIKE 'card:%' AND att."idempotencyKey"='charge:'||substr(p."clientKey",6)))))
    OR (a.entity,a."entityId",a.action) IS DISTINCT FROM ('BillingDunningClock',c.id,
      CASE WHEN NEW.kind='PAID' THEN 'BILLING_CLOCK_PAID_ADVANCE' ELSE 'BILLING_CLOCK_VOLUNTARY_RESUME' END)
    OR (a.changes->>'clockId',a.changes->>'tenantId',a.changes->>'fromSubscriptionId',a.changes->>'subscriptionId',
      a.changes->>'paymentId',a.changes->>'successEventId',a.changes->>'lapseEventId',a.changes->>'currencyCode') IS DISTINCT FROM
      (c.id,c."tenantId",c."subscriptionId",s.id,p.id,e.id,NEW."lapseEventId",NEW."currencyCode")
    OR (a.changes->>'previousEpoch')::integer IS DISTINCT FROM NEW."fromEpoch"
    OR (a.changes->>'nextEpoch')::integer IS DISTINCT FROM NEW."toEpoch"
    OR (a.changes->>'previousDue')::timestamp IS DISTINCT FROM NEW."fromDue"
    OR (a.changes->>'nextDue')::timestamp IS DISTINCT FROM NEW."toDue"
    OR (a.changes->>'amount')::numeric IS DISTINCT FROM NEW.amount THEN
    RAISE EXCEPTION 'Billing obligation requires exact retained settlement proof' USING ERRCODE='check_violation';
  END IF;
  IF NEW.kind='PAID' THEN
    IF NEW."toDue"<>p."periodEnd" OR p."periodStart">c."dueAt" OR p."periodEnd"<=c."dueAt"
      OR (s.id=c."subscriptionId" AND p."periodStart"<>c."dueAt")
      OR (s."currentPeriodStart",s."currentPeriodEnd",s."nextBillingDate") IS DISTINCT FROM (p."periodStart",p."periodEnd",NEW."toDue") THEN
      RAISE EXCEPTION 'Paid transition must cover the current obligation' USING ERRCODE='check_violation';
    END IF;
  ELSE
    SELECT * INTO lapse FROM billing_events WHERE id=NEW."lapseEventId";
    SELECT * INTO paid FROM billing_obligation_transitions WHERE "paymentId"=p.id AND kind='PAID';
    IF s.id<>c."subscriptionId" OR s.status<>'PAUSED' OR s."autoRenew" OR s."failedAttempts"<>0 OR c."pausedAt" IS NOT NULL
      OR (s."currentPeriodStart",s."currentPeriodEnd",s."nextBillingDate",c."dueAt") IS DISTINCT FROM
        (p."periodStart",p."periodEnd",p."periodEnd",p."periodEnd")
      OR NEW."toDue"<>NEW."effectiveAt" OR NEW."toDue"<c."dueAt"
      OR (paid.id IS NULL AND c.epoch<>1)
      OR (paid.id IS NOT NULL AND (paid."clockId",paid."toEpoch",paid."toDue") IS DISTINCT FROM (c.id,c.epoch,c."dueAt"))
      OR lapse.id IS NULL OR (lapse."subscriptionId",lapse.type::text,lapse."idempotencyKey",lapse.amount,lapse."currencyCode",lapse."paymentRef") IS DISTINCT FROM
        (s.id,'TIER_CHANGE','pause:'||s.id||':'||c.id||':'||c.epoch::text,p.amount,s."currencyCode",p."externalRef")
      OR EXISTS (SELECT 1 FROM payment_confirmation_holds WHERE "clockId"=c.id AND status IN ('ACTIVE','SETTLEMENT_APPLY_PENDING'))
      OR EXISTS (SELECT 1 FROM subscription_payments q WHERE billing_clock_source_matches(c.id,q."subscriptionId") AND q."periodStart">=c."dueAt")
      OR EXISTS (SELECT 1 FROM billing_events b WHERE billing_clock_source_matches(c.id,b."subscriptionId") AND b.type='CHARGE_ATTEMPT'
        AND b."idempotencyKey" LIKE 'charge:'||b."subscriptionId"||':'||to_char(c."dueAt",'YYYY-MM-DD')||'%') THEN
      RAISE EXCEPTION 'Voluntary resume requires unused exact lapse coverage' USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing_obligation_committed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c billing_dunning_clocks%ROWTYPE;
BEGIN
  SELECT * INTO c FROM billing_dunning_clocks WHERE id=NEW."clockId";
  IF c.id IS NULL OR c.epoch<NEW."toEpoch"
    OR (c.epoch=NEW."toEpoch" AND (c."dueAt",c."subscriptionId") IS DISTINCT FROM (NEW."toDue",NEW."subscriptionId"))
    OR (c.epoch>NEW."toEpoch" AND NOT EXISTS (SELECT 1 FROM billing_obligation_transitions t WHERE t."clockId"=c.id
      AND (t."fromEpoch",t."fromDue",t."fromSubscriptionId")=(NEW."toEpoch",NEW."toDue",NEW."subscriptionId"))) THEN
    RAISE EXCEPTION 'Billing obligation transition must commit with its clock' USING ERRCODE='check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION billing_obligation_parent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='subscription_payments' THEN
    IF (NEW.id,NEW."subscriptionId",NEW.status,NEW.amount,NEW."externalRef",NEW."periodStart",NEW."periodEnd",NEW."paidAt",NEW."paymentMethod") IS DISTINCT FROM
      (OLD.id,OLD."subscriptionId",OLD.status,OLD.amount,OLD."externalRef",OLD."periodStart",OLD."periodEnd",OLD."paidAt",OLD."paymentMethod")
      AND EXISTS (SELECT 1 FROM billing_obligation_transitions WHERE "paymentId"=OLD.id) THEN
      RAISE EXCEPTION 'Consumed payment coverage is immutable' USING ERRCODE='check_violation';
    END IF;
  ELSIF TG_TABLE_NAME='billing_events' THEN
    IF (NEW.id,NEW."subscriptionId",NEW.type,NEW.amount,NEW."currencyCode",NEW."paymentRef",NEW."idempotencyKey",NEW."createdAt",NEW.note) IS DISTINCT FROM
      (OLD.id,OLD."subscriptionId",OLD.type,OLD.amount,OLD."currencyCode",OLD."paymentRef",OLD."idempotencyKey",OLD."createdAt",OLD.note)
      AND EXISTS (SELECT 1 FROM billing_obligation_transitions WHERE "successEventId"=OLD.id OR "lapseEventId"=OLD.id) THEN
      RAISE EXCEPTION 'Consumed billing event is immutable' USING ERRCODE='check_violation';
    END IF;
  ELSIF NEW IS DISTINCT FROM OLD AND EXISTS (SELECT 1 FROM billing_obligation_transitions WHERE "auditId"=OLD.id) THEN
    RAISE EXCEPTION 'Billing obligation audit is immutable' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE billing_obligation_transitions DROP CONSTRAINT IF EXISTS billing_obligation_reanchor_shape;
ALTER TABLE billing_obligation_transitions DROP CONSTRAINT billing_obligation_transitions_kind_check;
ALTER TABLE billing_obligation_transitions ADD CONSTRAINT billing_obligation_transitions_kind_check CHECK (kind IN ('PAID','VOLUNTARY_RESUME'));
ALTER TABLE billing_obligation_transitions DROP COLUMN IF EXISTS "suspensionEventId";
ALTER TABLE billing_obligation_transitions ALTER COLUMN "paymentId" SET NOT NULL, ALTER COLUMN "successEventId" SET NOT NULL;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016210000_billing_return_reanchor';
COMMIT;
