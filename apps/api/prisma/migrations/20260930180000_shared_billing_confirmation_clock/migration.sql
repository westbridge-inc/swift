-- Expand only. Keep all old billing/API writers stopped through the versioned resolver backfill.
-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "billingConfirmationPausedAt" TIMESTAMP(3),
ADD COLUMN     "billingEnforcementDueAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "billing_dunning_clocks" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "moverPayerUserId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    "elapsedMs" BIGINT NOT NULL DEFAULT 0,
    "runningSince" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "resumedAt" TIMESTAMP(3),
    "authorityHoldReason" TEXT,
    "authorityRevision" INTEGER,
    "retryAtMs" BIGINT,
    "nudgeAtMs" BIGINT,
    "churnAtMs" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_dunning_clocks_pkey" PRIMARY KEY ("id")
);

-- Consumed settled coverage; it cannot be reassigned to another clock/source.
CREATE TABLE billing_obligation_transitions (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "clockId" TEXT NOT NULL REFERENCES billing_dunning_clocks(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "fromSubscriptionId" TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "subscriptionId" TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('PAID','VOLUNTARY_RESUME')),
  "fromEpoch" INTEGER NOT NULL CHECK ("fromEpoch">0),
  "toEpoch" INTEGER NOT NULL CHECK ("toEpoch"="fromEpoch"+1),
  "fromDue" TIMESTAMP(3) NOT NULL,
  "toDue" TIMESTAMP(3) NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "paymentId" TEXT NOT NULL REFERENCES subscription_payments(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "successEventId" TEXT NOT NULL REFERENCES billing_events(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "lapseEventId" TEXT UNIQUE REFERENCES billing_events(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "auditId" TEXT NOT NULL UNIQUE REFERENCES audit_logs(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  amount DECIMAL(10,2) NOT NULL CHECK (amount>=0),
  "currencyCode" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL CHECK ("periodEnd">"periodStart"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("clockId","toEpoch"), UNIQUE ("paymentId",kind),
  CHECK ((kind='VOLUNTARY_RESUME')=("lapseEventId" IS NOT NULL))
);
CREATE INDEX "billing_obligation_transitions_tenantId_idx" ON billing_obligation_transitions("tenantId");

-- CreateTable
CREATE TABLE "payment_confirmation_holds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "clockId" TEXT NOT NULL,
    "sourceEpoch" INTEGER NOT NULL,
    "paymentId" TEXT,
    "checkoutId" TEXT,
    "cardSessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "beganAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionEvidence" TEXT,
    "resolutionHistory" JSONB NOT NULL DEFAULT '[]',
    "reviewDueAt" TIMESTAMP(3) NOT NULL,
    "reviewNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_confirmation_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_fee_notices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "clockId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "stageKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_fee_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_notice_handoffs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "noticeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "part" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_notice_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_dunning_clocks_subscriptionId_key" ON "billing_dunning_clocks"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_dunning_clocks_moverPayerUserId_key" ON "billing_dunning_clocks"("moverPayerUserId");

-- CreateIndex
CREATE INDEX "billing_dunning_clocks_tenantId_idx" ON "billing_dunning_clocks"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_dunning_clocks_moverPayerUserId_tenantId_key" ON "billing_dunning_clocks"("moverPayerUserId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_confirmation_holds_paymentId_key" ON "payment_confirmation_holds"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_confirmation_holds_checkoutId_key" ON "payment_confirmation_holds"("checkoutId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_confirmation_holds_cardSessionId_key" ON "payment_confirmation_holds"("cardSessionId");

-- CreateIndex
CREATE INDEX "payment_confirmation_holds_tenantId_idx" ON "payment_confirmation_holds"("tenantId");

-- CreateIndex
CREATE INDEX "payment_confirmation_holds_subscriptionId_status_idx" ON "payment_confirmation_holds"("subscriptionId", "status");

-- CreateIndex
CREATE INDEX "payment_confirmation_holds_status_reviewDueAt_idx" ON "payment_confirmation_holds"("status", "reviewDueAt");

-- CreateIndex
CREATE INDEX "billing_fee_notices_tenantId_idx" ON "billing_fee_notices"("tenantId");

-- CreateIndex
CREATE INDEX "billing_fee_notices_status_createdAt_idx" ON "billing_fee_notices"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_fee_notices_clockId_epoch_stageKey_userId_key" ON "billing_fee_notices"("clockId", "epoch", "stageKey", "userId");

-- CreateIndex
CREATE INDEX "billing_notice_handoffs_tenantId_idx" ON "billing_notice_handoffs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_notice_handoffs_noticeId_channel_part_key" ON "billing_notice_handoffs"("noticeId", "channel", "part");

-- AddForeignKey
ALTER TABLE "billing_dunning_clocks" ADD CONSTRAINT "billing_dunning_clocks_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_dunning_clocks" ADD CONSTRAINT "billing_dunning_clocks_moverPayerUserId_tenantId_fkey" FOREIGN KEY ("moverPayerUserId", "tenantId") REFERENCES "mover_fee_authorities"("userId", "tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_confirmation_holds" ADD CONSTRAINT "payment_confirmation_holds_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_confirmation_holds" ADD CONSTRAINT "payment_confirmation_holds_clockId_fkey" FOREIGN KEY ("clockId") REFERENCES "billing_dunning_clocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_confirmation_holds" ADD CONSTRAINT "payment_confirmation_holds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "subscription_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_confirmation_holds" ADD CONSTRAINT "payment_confirmation_holds_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "mmg_checkout_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_confirmation_holds" ADD CONSTRAINT "payment_confirmation_holds_cardSessionId_fkey" FOREIGN KEY ("cardSessionId") REFERENCES "card_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_fee_notices" ADD CONSTRAINT "billing_fee_notices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_fee_notices" ADD CONSTRAINT "billing_fee_notices_clockId_fkey" FOREIGN KEY ("clockId") REFERENCES "billing_dunning_clocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_fee_notices" ADD CONSTRAINT "billing_fee_notices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_notice_handoffs" ADD CONSTRAINT "billing_notice_handoffs_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "billing_fee_notices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Expand only. The exact resolver backfill completes the protected cutover gate.
CREATE FUNCTION billing_clock_payer(p_subscription text)
RETURNS TABLE ("userId" text, "tenantId" text) LANGUAGE sql STABLE AS $$
  SELECT u.id,u."tenantId" FROM subscriptions s
  LEFT JOIN riders r ON r.id=s."riderId" LEFT JOIN drivers d ON d.id=s."driverId"
  LEFT JOIN vendors v ON v.id=s."vendorId" LEFT JOIN vendor_owners vo ON vo.id=v."ownerId"
  JOIN users u ON u.id=COALESCE(r."userId",d."userId",vo."userId")
  WHERE s.id=p_subscription AND num_nonnulls(s."riderId",s."driverId",s."vendorId")=1
    AND (v.id IS NULL OR v."tenantId"=u."tenantId")
$$;
CREATE FUNCTION billing_clock_source_matches(p_clock text,p_source text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM billing_dunning_clocks c CROSS JOIN LATERAL billing_clock_payer(p_source) p
    WHERE c.id=p_clock AND c."tenantId"=p."tenantId" AND (
      (c."moverPayerUserId" IS NULL AND c."subscriptionId"=p_source)
      OR (c."moverPayerUserId"=p."userId" AND EXISTS (SELECT 1 FROM mover_fee_subscriptions m
        WHERE m."subscriptionId"=p_source AND m."userId"=c."moverPayerUserId" AND m."tenantId"=c."tenantId"))))
$$;
ALTER TABLE billing_dunning_clocks ADD CONSTRAINT billing_clock_shape CHECK (
  epoch>0 AND version>=0 AND "elapsedMs">=0 AND num_nonnulls("runningSince","pausedAt")=1
  AND ("retryAtMs" IS NULL OR "retryAtMs">=0) AND ("nudgeAtMs" IS NULL OR "nudgeAtMs">=0)
  AND ("churnAtMs" IS NULL OR "churnAtMs">=0)
  AND ("authorityHoldReason" IS NULL OR "pausedAt" IS NOT NULL));
ALTER TABLE payment_confirmation_holds ADD CONSTRAINT confirmation_source_shape CHECK (
  num_nonnulls("paymentId","checkoutId","cardSessionId")=1 AND "sourceEpoch">0
  AND length(reason)>0 AND "reviewDueAt">="beganAt" AND jsonb_typeof("resolutionHistory")='array'
  AND ((status IN ('ACTIVE','SETTLEMENT_APPLY_PENDING') AND "resolvedAt" IS NULL AND "resolvedBy" IS NULL AND "resolutionEvidence" IS NULL)
    OR (status IN ('PAID','PROVEN_UNPAID','PROVEN_NO_EFFECT') AND "resolvedAt" IS NOT NULL
      AND length(btrim("resolvedBy"))>0 AND length(btrim("resolutionEvidence"))>0)));
ALTER TABLE billing_fee_notices ADD CONSTRAINT billing_notice_shape CHECK (
  epoch>0 AND length("stageKey")>0 AND status IN ('PENDING','DELIVERED','OBSOLETE'));
ALTER TABLE billing_notice_handoffs ADD CONSTRAINT billing_handoff_shape CHECK (
  length(channel)>0 AND length(part)>0 AND status IN ('PREPARED','UNKNOWN','DELIVERED','NOT_SENT'));

-- A transition is inserted while the prior clock is locked. JSON audits are
-- checked against typed money/source facts; they cannot substitute for them.
CREATE FUNCTION billing_obligation_proof() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER billing_obligation_proof BEFORE INSERT OR UPDATE ON billing_obligation_transitions FOR EACH ROW EXECUTE FUNCTION billing_obligation_proof();

-- Every inserted proof must be consumed in the same transaction. Multiple
-- legitimate transitions in one transaction form an unbroken epoch chain.
CREATE FUNCTION billing_obligation_committed() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER billing_obligation_committed AFTER INSERT ON billing_obligation_transitions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_obligation_committed();

CREATE FUNCTION billing_obligation_parent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER billing_obligation_parent_immutable BEFORE UPDATE ON subscription_payments FOR EACH ROW EXECUTE FUNCTION billing_obligation_parent_immutable();
CREATE TRIGGER billing_obligation_parent_immutable BEFORE UPDATE ON billing_events FOR EACH ROW EXECUTE FUNCTION billing_obligation_parent_immutable();
CREATE TRIGGER billing_obligation_parent_immutable BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION billing_obligation_parent_immutable();

CREATE FUNCTION billing_clock_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; owner_tenant text; is_vendor boolean; initial_due timestamp; authority mover_fee_authorities%ROWTYPE; decision audit_logs%ROWTYPE;
BEGIN
  SELECT p."userId",p."tenantId",s."vendorId" IS NOT NULL,s."nextBillingDate" INTO owner_id,owner_tenant,is_vendor,initial_due
  FROM subscriptions s CROSS JOIN LATERAL billing_clock_payer(s.id) p WHERE s.id=NEW."subscriptionId";
  IF owner_id IS NULL OR owner_tenant<>NEW."tenantId" OR (is_vendor AND NEW."moverPayerUserId" IS NOT NULL)
    OR (NOT is_vendor AND NEW."moverPayerUserId" IS DISTINCT FROM owner_id) THEN
    RAISE EXCEPTION 'Billing clock ownership unavailable' USING ERRCODE='check_violation';
  END IF;
  IF NOT is_vendor THEN
    SELECT * INTO authority FROM mover_fee_authorities WHERE "userId"=owner_id AND "tenantId"=owner_tenant;
    IF authority."canonicalSubscriptionId" IS DISTINCT FROM NEW."subscriptionId" THEN
      RAISE EXCEPTION 'Billing clock canonical source unavailable' USING ERRCODE='check_violation';
    END IF;
  END IF;
  IF TG_OP='INSERT' AND (NEW."dueAt",NEW.epoch,NEW."elapsedMs",NEW."runningSince",NEW."pausedAt",NEW."resumedAt") IS DISTINCT FROM
    (initial_due,1,0::bigint,initial_due,NULL::timestamp,NULL::timestamp) THEN
    RAISE EXCEPTION 'Billing initial obligation must retain its source due and time' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW."tenantId",NEW."moverPayerUserId",NEW."createdAt") IS DISTINCT FROM (OLD.id,OLD."tenantId",OLD."moverPayerUserId",OLD."createdAt")
      OR (NEW."dueAt"<>OLD."dueAt" AND NOT (NEW.epoch=OLD.epoch+1 AND NEW."elapsedMs"=0))
      OR NEW.epoch<OLD.epoch OR NEW.epoch>OLD.epoch+1 OR NEW.version<OLD.version THEN
      RAISE EXCEPTION 'Billing clock identity is immutable' USING ERRCODE='check_violation';
    END IF;
    IF NEW.epoch=OLD.epoch THEN
      IF OLD."pausedAt" IS NULL AND NEW."pausedAt" IS NOT NULL THEN
        IF NEW."elapsedMs"<>OLD."elapsedMs"+GREATEST(0,(extract(epoch FROM NEW."pausedAt"-OLD."runningSince")*1000)::bigint)
          OR NEW."runningSince" IS NOT NULL OR NEW."resumedAt" IS DISTINCT FROM OLD."resumedAt" THEN
          RAISE EXCEPTION 'Billing pause must preserve accrued time' USING ERRCODE='check_violation';
        END IF;
      ELSIF OLD."pausedAt" IS NOT NULL AND NEW."pausedAt" IS NULL THEN
        IF NEW."elapsedMs"<>OLD."elapsedMs" OR NEW."resumedAt" IS NULL OR NEW."resumedAt"<OLD."pausedAt"
          OR NEW."runningSince" IS DISTINCT FROM GREATEST(NEW."resumedAt",NEW."dueAt")
          OR NEW."authorityHoldReason" IS NOT NULL
          OR EXISTS (SELECT 1 FROM payment_confirmation_holds WHERE "clockId"=OLD.id AND status IN ('ACTIVE','SETTLEMENT_APPLY_PENDING')) THEN
          RAISE EXCEPTION 'Billing resume must preserve remaining time' USING ERRCODE='check_violation';
        END IF;
      ELSIF (NEW."elapsedMs",NEW."runningSince",NEW."pausedAt",NEW."resumedAt") IS DISTINCT FROM
        (OLD."elapsedMs",OLD."runningSince",OLD."pausedAt",OLD."resumedAt") THEN
        RAISE EXCEPTION 'Billing clock cannot reset accrued time' USING ERRCODE='check_violation';
      END IF;
    ELSE
      IF NEW."elapsedMs"<>0 OR NEW."resumedAt" IS NOT NULL
        OR (NEW."runningSince" IS NOT NULL AND NEW."runningSince"<>NEW."dueAt")
        OR NOT EXISTS (SELECT 1 FROM billing_obligation_transitions t WHERE t."clockId"=OLD.id AND t."tenantId"=OLD."tenantId"
          AND (t."fromSubscriptionId",t."subscriptionId",t."fromEpoch",t."toEpoch",t."fromDue",t."toDue")=
            (OLD."subscriptionId",NEW."subscriptionId",OLD.epoch,NEW.epoch,OLD."dueAt",NEW."dueAt")) THEN
        RAISE EXCEPTION 'Billing epoch change requires its exact consumed settlement' USING ERRCODE='check_violation';
      END IF;
    END IF;
    IF NEW."subscriptionId"<>OLD."subscriptionId" THEN
      SELECT * INTO decision FROM audit_logs WHERE id=authority."decisionId";
      IF is_vendor OR decision.action IS DISTINCT FROM 'MOVER_FEE_RESOLVED'
        OR (decision.changes->>'previousRevision')::integer IS DISTINCT FROM OLD."authorityRevision"
        OR authority.revision IS DISTINCT FROM OLD."authorityRevision"+1
        OR EXISTS (SELECT 1 FROM payment_confirmation_holds WHERE "clockId"=OLD.id AND status IN ('ACTIVE','SETTLEMENT_APPLY_PENDING'))
        OR NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity='BillingDunningClock' AND a."entityId"=OLD.id
          AND a.action='BILLING_CLOCK_CANONICAL_CHANGED' AND a.changes->>'authorityDecisionId'=authority."decisionId"
          AND a.changes->>'canonicalSubscriptionId'=NEW."subscriptionId" AND a.changes->>'clockId'=OLD.id
          AND a.changes->'previous'->>'subscriptionId'=OLD."subscriptionId"
          AND a.changes->>'tenantId'=OLD."tenantId") THEN
        RAISE EXCEPTION 'Billing canonical transition requires its exact audited authority' USING ERRCODE='check_violation';
      END IF;
      IF NEW."dueAt"=OLD."dueAt" THEN
        IF (NEW.epoch,NEW."elapsedMs",NEW."runningSince",NEW."pausedAt",NEW."retryAtMs",NEW."nudgeAtMs",NEW."churnAtMs") IS DISTINCT FROM
          (OLD.epoch,OLD."elapsedMs",OLD."runningSince",OLD."pausedAt",OLD."retryAtMs",OLD."nudgeAtMs",OLD."churnAtMs") THEN
          RAISE EXCEPTION 'Canonical projection cannot reset its obligation clock' USING ERRCODE='check_violation';
        END IF;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM subscriptions s JOIN subscription_payments p ON p."subscriptionId"=s.id
          JOIN billing_events e ON e."subscriptionId"=s.id AND e.type='CHARGE_SUCCESS' AND e.amount=p.amount
            AND e."paymentRef"=p."externalRef" AND e."currencyCode"=s."currencyCode"
          WHERE s.id=NEW."subscriptionId" AND p.status='CAPTURED' AND p."paidAt" IS NOT NULL
            AND p."periodStart"=s."currentPeriodStart" AND p."periodEnd"=s."currentPeriodEnd"
            AND s."currentPeriodStart"<=OLD."dueAt" AND s."currentPeriodEnd">OLD."dueAt"
            AND s."currentPeriodEnd"=NEW."dueAt" AND NEW.epoch=OLD.epoch+1) THEN
          RAISE EXCEPTION 'New billing obligation requires covered entitlement' USING ERRCODE='check_violation';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_clock_lineage BEFORE INSERT OR UPDATE ON billing_dunning_clocks FOR EACH ROW EXECUTE FUNCTION billing_clock_lineage();

CREATE FUNCTION billing_confirmation_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
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
      IF COALESCE(OLD.status='PROVEN_UNPAID' AND NEW.status='ACTIVE' AND NEW."checkoutId" IS NOT NULL
        AND NEW."sourceEpoch"=c.epoch AND jsonb_array_length(NEW."resolutionHistory")=old_length+1
        AND correction->>'status'='LATE_POSITIVE_REVIEW'
        AND EXISTS (SELECT 1 FROM mmg_checkout_intents m WHERE m.id=NEW."checkoutId" AND m.status='HELD'), false) THEN
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
CREATE TRIGGER billing_confirmation_lineage BEFORE INSERT OR UPDATE ON payment_confirmation_holds FOR EACH ROW EXECUTE FUNCTION billing_confirmation_lineage();

CREATE FUNCTION billing_notice_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_tenant text; parent_epoch integer; recipient_tenant text;
BEGIN
  IF TG_TABLE_NAME='billing_fee_notices' THEN
    SELECT "tenantId",epoch INTO owner_tenant,parent_epoch FROM billing_dunning_clocks WHERE id=NEW."clockId";
    SELECT "tenantId" INTO recipient_tenant FROM users WHERE id=NEW."userId";
    IF recipient_tenant IS DISTINCT FROM owner_tenant OR NEW.epoch>parent_epoch OR NOT billing_clock_source_matches(NEW."clockId",NEW."subscriptionId") THEN
      RAISE EXCEPTION 'Fee notice source or recipient unavailable' USING ERRCODE='check_violation';
    END IF;
    IF TG_OP='UPDATE' AND (NEW."tenantId",NEW."subscriptionId",NEW."clockId",NEW.epoch,NEW."stageKey",NEW."userId",NEW.payload)
      IS DISTINCT FROM (OLD."tenantId",OLD."subscriptionId",OLD."clockId",OLD.epoch,OLD."stageKey",OLD."userId",OLD.payload) THEN
      RAISE EXCEPTION 'Fee notice identity is immutable' USING ERRCODE='check_violation';
    END IF;
  ELSE
    SELECT "tenantId" INTO owner_tenant FROM billing_fee_notices WHERE id=NEW."noticeId";
    IF TG_OP='UPDATE' AND ((NEW."tenantId",NEW."noticeId",NEW.channel,NEW.part) IS DISTINCT FROM (OLD."tenantId",OLD."noticeId",OLD.channel,OLD.part)
      OR (OLD.status='DELIVERED' AND NEW.status<>'DELIVERED')) THEN
      RAISE EXCEPTION 'Fee handoff identity is immutable' USING ERRCODE='check_violation';
    END IF;
  END IF;
  IF owner_tenant IS NULL OR owner_tenant<>NEW."tenantId" THEN RAISE EXCEPTION 'Fee notice ownership unavailable' USING ERRCODE='check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_notice_lineage BEFORE INSERT OR UPDATE ON billing_fee_notices FOR EACH ROW EXECUTE FUNCTION billing_notice_lineage();
CREATE TRIGGER billing_handoff_lineage BEFORE INSERT OR UPDATE ON billing_notice_handoffs FOR EACH ROW EXECUTE FUNCTION billing_notice_lineage();

-- A parent edit cannot strand existing source/clock evidence in another owner.
CREATE FUNCTION billing_preserve_parent_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing_obligation_transitions t
    LEFT JOIN LATERAL billing_clock_payer(t."subscriptionId") p ON true
    LEFT JOIN LATERAL billing_clock_payer(t."fromSubscriptionId") q ON true
    JOIN billing_dunning_clocks c ON c.id=t."clockId"
    WHERE p."tenantId" IS DISTINCT FROM t."tenantId" OR q."tenantId" IS DISTINCT FROM t."tenantId"
      OR p."userId" IS DISTINCT FROM q."userId"
      OR (c."moverPayerUserId" IS NOT NULL AND p."userId" IS DISTINCT FROM c."moverPayerUserId")) THEN
    RAISE EXCEPTION 'Consumed obligation source ownership is immutable' USING ERRCODE='check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM billing_dunning_clocks c LEFT JOIN LATERAL billing_clock_payer(c."subscriptionId") p ON true
    WHERE p."tenantId" IS DISTINCT FROM c."tenantId" OR (c."moverPayerUserId" IS NOT NULL AND p."userId" IS DISTINCT FROM c."moverPayerUserId"))
    OR EXISTS (SELECT 1 FROM payment_confirmation_holds h WHERE NOT billing_clock_source_matches(h."clockId",h."subscriptionId")) THEN
    RAISE EXCEPTION 'Billing evidence must retain its original payer and tenant' USING ERRCODE='check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER billing_parent_lineage AFTER UPDATE ON users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId") EXECUTE FUNCTION billing_preserve_parent_lineage();
CREATE CONSTRAINT TRIGGER billing_parent_lineage AFTER UPDATE ON subscriptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((OLD."riderId",OLD."driverId",OLD."vendorId") IS DISTINCT FROM (NEW."riderId",NEW."driverId",NEW."vendorId")) EXECUTE FUNCTION billing_preserve_parent_lineage();
CREATE CONSTRAINT TRIGGER billing_parent_lineage AFTER UPDATE ON riders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD."userId" IS DISTINCT FROM NEW."userId") EXECUTE FUNCTION billing_preserve_parent_lineage();
CREATE CONSTRAINT TRIGGER billing_parent_lineage AFTER UPDATE ON drivers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD."userId" IS DISTINCT FROM NEW."userId") EXECUTE FUNCTION billing_preserve_parent_lineage();
CREATE CONSTRAINT TRIGGER billing_parent_lineage AFTER UPDATE ON vendors DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((OLD."tenantId",OLD."ownerId") IS DISTINCT FROM (NEW."tenantId",NEW."ownerId")) EXECUTE FUNCTION billing_preserve_parent_lineage();
CREATE CONSTRAINT TRIGGER billing_parent_lineage AFTER UPDATE ON vendor_owners DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD."userId" IS DISTINCT FROM NEW."userId") EXECUTE FUNCTION billing_preserve_parent_lineage();

CREATE FUNCTION billing_confirmation_missing_coverage() RETURNS bigint LANGUAGE sql STABLE AS $$
  WITH originals AS (
    SELECT s.id,s."vendorId",p."userId",p."tenantId",m."userId" AS mapped_payer,a."canonicalSubscriptionId"
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
  SELECT (SELECT count(*) FROM originals o LEFT JOIN billing_dunning_clocks c ON c."subscriptionId"=CASE WHEN o."vendorId" IS NOT NULL THEN o.id ELSE o."canonicalSubscriptionId" END
    WHERE o."userId" IS NULL OR c.id IS NULL OR c."tenantId" IS DISTINCT FROM o."tenantId"
      OR (o."vendorId" IS NULL AND (o.mapped_payer IS DISTINCT FROM o."userId" OR c."moverPayerUserId" IS DISTINCT FROM o."userId")))
    + (SELECT count(*) FROM unresolved u WHERE NOT EXISTS (SELECT 1 FROM payment_confirmation_holds h
      WHERE h."subscriptionId"=u."subscriptionId" AND ((u.kind='checkout' AND h."checkoutId"=u.id)
        OR (u.kind='card' AND h."cardSessionId"=u.id) OR (u.kind='payment' AND h."paymentId"=u.id))))
    + (SELECT count(*) FROM mover_fee_authorities a LEFT JOIN billing_dunning_clocks c ON c."moverPayerUserId"=a."userId"
      WHERE c.id IS NULL OR c."subscriptionId"<>a."canonicalSubscriptionId" OR c."authorityRevision" IS DISTINCT FROM a.revision
        OR (a.state='FINANCE_HOLD' AND (c."pausedAt" IS NULL OR c."authorityHoldReason" IS DISTINCT FROM a."holdReason")))
    + (SELECT count(*) FROM payment_confirmation_holds h JOIN billing_dunning_clocks c ON c.id=h."clockId"
      WHERE h.status IN ('ACTIVE','SETTLEMENT_APPLY_PENDING') AND c."pausedAt" IS NULL)
$$;

CREATE FUNCTION billing_cutover_protected() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous jsonb; missing bigint;
BEGIN
  IF (TG_OP='DELETE' AND OLD.key='system:billing-confirmation-cutover:v1')
    OR (TG_OP='UPDATE' AND OLD.key='system:billing-confirmation-cutover:v1' AND NEW.key<>OLD.key) THEN
    RAISE EXCEPTION 'Billing cutover authority is permanent' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.key<>'system:billing-confirmation-cutover:v1' THEN RETURN NEW; END IF;
  IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='platform_config'::regclass)) THEN
    RAISE EXCEPTION 'Billing cutover completion requires the migration owner' USING ERRCODE='insufficient_privilege';
  END IF;
  IF jsonb_typeof(NEW.value) IS DISTINCT FROM 'object' OR NEW.value->>'version' IS DISTINCT FROM '20260930180000-v1'
    OR NEW.value->>'state' IS NULL OR NEW.value->>'state' NOT IN ('BLOCKED','READY') THEN
    RAISE EXCEPTION 'Billing cutover version unavailable' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='UPDATE' THEN
    previous:=OLD.value;
    IF previous->>'state'='READY' OR NEW.value->>'startedAt' IS DISTINCT FROM previous->>'startedAt'
      OR NEW.value->>'version' IS DISTINCT FROM previous->>'version' THEN
      RAISE EXCEPTION 'Billing cutover completion is one way' USING ERRCODE='check_violation';
    END IF;
  END IF;
  IF NEW.value->>'state'='READY' THEN
    missing:=billing_confirmation_missing_coverage();
    IF TG_OP<>'UPDATE' OR previous->>'state'<>'BLOCKED' OR missing<>0
      OR NEW.value->>'completedAt' IS NULL OR NEW.value->>'coverageDigest' IS NULL
      OR NOT EXISTS (SELECT 1 FROM audit_logs WHERE action='BILLING_CONFIRMATION_CUTOVER_READY' AND entity='BillingConfirmationCutover'
        AND "entityId"=NEW.key AND changes->>'version'=NEW.value->>'version' AND changes->>'coverageDigest'=NEW.value->>'coverageDigest') THEN
      RAISE EXCEPTION 'Billing cutover coverage is incomplete' USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_cutover_protected BEFORE INSERT OR UPDATE OR DELETE ON platform_config FOR EACH ROW EXECUTE FUNCTION billing_cutover_protected();
INSERT INTO platform_config(id,key,value,"updatedAt") VALUES (gen_random_uuid()::text,'system:billing-confirmation-cutover:v1',
  jsonb_build_object('version','20260930180000-v1','state','BLOCKED','startedAt',CURRENT_TIMESTAMP),CURRENT_TIMESTAMP);
-- Protect existing work while mapping is incomplete; completed suspensions and
-- manual stops remain authoritative. No paid period or due date is rewritten.
UPDATE subscriptions SET "billingConfirmationPausedAt"=CURRENT_TIMESTAMP,"billingEnforcementDueAt"=NULL;

CREATE FUNCTION billing_complete_confirmation_backfill(p_version text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE marker platform_config%ROWTYPE; digest text; completed_at timestamptz:=clock_timestamp(); missing bigint;
BEGIN
  SELECT * INTO marker FROM platform_config WHERE key='system:billing-confirmation-cutover:v1' FOR UPDATE;
  IF marker.id IS NULL OR p_version<>'20260930180000-v1' OR marker.value->>'version'<>p_version THEN RAISE EXCEPTION 'Billing cutover version unavailable'; END IF;
  IF marker.value->>'state'='READY' THEN RETURN marker.value->>'coverageDigest'; END IF;
  missing:=billing_confirmation_missing_coverage();
  IF missing<>0 THEN RAISE EXCEPTION 'Billing cutover coverage incomplete: %',missing; END IF;
  SELECT encode(sha256(convert_to(COALESCE(string_agg(id||':'||"subscriptionId"||':'||epoch::text||':'||version::text,',' ORDER BY id),''),'UTF8')),'hex')
    INTO digest FROM billing_dunning_clocks;
  INSERT INTO audit_logs(id,action,entity,"entityId",changes,"createdAt") VALUES (gen_random_uuid()::text,'BILLING_CONFIRMATION_CUTOVER_READY',
    'BillingConfirmationCutover',marker.key,jsonb_build_object('version',p_version,'coverageDigest',digest,'completedAt',completed_at),completed_at);
  UPDATE platform_config SET value=value||jsonb_build_object('state','READY','completedAt',completed_at,'coverageDigest',digest),"updatedAt"=completed_at WHERE id=marker.id;
  UPDATE subscriptions s SET "billingConfirmationPausedAt"=c."pausedAt",
    "billingEnforcementDueAt"=CASE WHEN c."pausedAt" IS NULL THEN c."runningSince"+((172800000-c."elapsedMs")*interval '1 millisecond') END,
    "gracePeriodEnd"=CASE WHEN s.status='PAST_DUE' THEN CASE WHEN c."pausedAt" IS NULL THEN c."runningSince"+((172800000-c."elapsedMs")*interval '1 millisecond') END ELSE s."gracePeriodEnd" END,
    "nextRetryAt"=CASE WHEN s.id=c."subscriptionId" AND s."autoRenew" AND c."pausedAt" IS NULL AND c."retryAtMs" IS NOT NULL
      AND NOT (s.status IN ('TRIAL','ACTIVE') AND s."failedAttempts"=0) THEN c."runningSince"+((c."retryAtMs"-c."elapsedMs")*interval '1 millisecond') END
  FROM billing_dunning_clocks c WHERE s.id=c."subscriptionId" OR EXISTS (
    SELECT 1 FROM mover_fee_subscriptions m WHERE m."subscriptionId"=s.id AND m."userId"=c."moverPayerUserId" AND m."tenantId"=c."tenantId");
  RETURN digest;
END $$;
REVOKE ALL ON FUNCTION billing_complete_confirmation_backfill(text) FROM PUBLIC;

ALTER TABLE "billing_dunning_clocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_dunning_clocks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing_dunning_clocks"
USING ("tenantId"=current_setting('app.current_tenant',true) OR pg_has_role(current_user,'swift_bypass_rls','MEMBER'))
WITH CHECK ("tenantId"=current_setting('app.current_tenant',true) OR pg_has_role(current_user,'swift_bypass_rls','MEMBER'));

ALTER TABLE "payment_confirmation_holds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_confirmation_holds" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_confirmation_holds"
USING ("tenantId"=current_setting('app.current_tenant',true) OR pg_has_role(current_user,'swift_bypass_rls','MEMBER'))
WITH CHECK ("tenantId"=current_setting('app.current_tenant',true) OR pg_has_role(current_user,'swift_bypass_rls','MEMBER'));

ALTER TABLE "billing_fee_notices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_fee_notices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing_fee_notices"
USING ("tenantId"=current_setting('app.current_tenant',true) OR pg_has_role(current_user,'swift_bypass_rls','MEMBER'))
WITH CHECK ("tenantId"=current_setting('app.current_tenant',true) OR pg_has_role(current_user,'swift_bypass_rls','MEMBER'));

ALTER TABLE "billing_notice_handoffs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_notice_handoffs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing_notice_handoffs"
USING ("tenantId"=current_setting('app.current_tenant',true) OR pg_has_role(current_user,'swift_bypass_rls','MEMBER'))
WITH CHECK ("tenantId"=current_setting('app.current_tenant',true) OR pg_has_role(current_user,'swift_bypass_rls','MEMBER'));

GRANT SELECT,INSERT,UPDATE ON billing_dunning_clocks,payment_confirmation_holds,billing_fee_notices,billing_notice_handoffs TO swift_app;
REVOKE DELETE ON billing_dunning_clocks,payment_confirmation_holds,billing_fee_notices,billing_notice_handoffs FROM swift_app;

CREATE FUNCTION billing_confirmation_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER billing_confirmation_source_immutable BEFORE UPDATE ON subscription_payments FOR EACH ROW EXECUTE FUNCTION billing_confirmation_source_immutable();
CREATE TRIGGER billing_confirmation_source_immutable BEFORE UPDATE ON mmg_checkout_intents FOR EACH ROW EXECUTE FUNCTION billing_confirmation_source_immutable();
CREATE TRIGGER billing_confirmation_source_immutable BEFORE UPDATE ON card_sessions FOR EACH ROW EXECUTE FUNCTION billing_confirmation_source_immutable();

ALTER TABLE billing_obligation_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_obligation_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_obligation_transitions
USING ("tenantId"=current_setting('app.current_tenant',true) OR pg_has_role(current_user,'swift_bypass_rls','MEMBER'))
WITH CHECK ("tenantId"=current_setting('app.current_tenant',true) OR pg_has_role(current_user,'swift_bypass_rls','MEMBER'));
GRANT SELECT,INSERT ON billing_obligation_transitions TO swift_app;
REVOKE UPDATE,DELETE ON billing_obligation_transitions FROM swift_app;
