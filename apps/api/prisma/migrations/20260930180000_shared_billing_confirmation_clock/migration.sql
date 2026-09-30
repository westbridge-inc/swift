-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "billingConfirmationPausedAt" TIMESTAMP(3),
ADD COLUMN     "billingEnforcementDueAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "billing_dunning_clocks" (
    "subscriptionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    "elapsedMs" BIGINT NOT NULL DEFAULT 0,
    "runningSince" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "resumedAt" TIMESTAMP(3),
    "retryAtMs" BIGINT,
    "nudgeAtMs" BIGINT,
    "churnAtMs" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_dunning_clocks_pkey" PRIMARY KEY ("subscriptionId")
);

-- CreateTable
CREATE TABLE "payment_confirmation_holds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
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
CREATE INDEX "billing_dunning_clocks_tenantId_idx" ON "billing_dunning_clocks"("tenantId");

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
CREATE UNIQUE INDEX "billing_fee_notices_subscriptionId_epoch_stageKey_userId_key" ON "billing_fee_notices"("subscriptionId", "epoch", "stageKey", "userId");

-- CreateIndex
CREATE INDEX "billing_notice_handoffs_tenantId_idx" ON "billing_notice_handoffs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_notice_handoffs_noticeId_channel_part_key" ON "billing_notice_handoffs"("noticeId", "channel", "part");

-- AddForeignKey
ALTER TABLE "billing_dunning_clocks" ADD CONSTRAINT "billing_dunning_clocks_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_confirmation_holds" ADD CONSTRAINT "payment_confirmation_holds_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "billing_dunning_clocks"("subscriptionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_confirmation_holds" ADD CONSTRAINT "payment_confirmation_holds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "subscription_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_confirmation_holds" ADD CONSTRAINT "payment_confirmation_holds_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "mmg_checkout_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_confirmation_holds" ADD CONSTRAINT "payment_confirmation_holds_cardSessionId_fkey" FOREIGN KEY ("cardSessionId") REFERENCES "card_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_fee_notices" ADD CONSTRAINT "billing_fee_notices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "billing_dunning_clocks"("subscriptionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_fee_notices" ADD CONSTRAINT "billing_fee_notices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_notice_handoffs" ADD CONSTRAINT "billing_notice_handoffs_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "billing_fee_notices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One owner, one clock; no tenant default may silently stamp money evidence.
CREATE FUNCTION billing_clock_payer(p_subscription text)
RETURNS TABLE ("userId" text, "tenantId" text) LANGUAGE sql STABLE AS $$
  SELECT u.id, u."tenantId" FROM subscriptions s
  LEFT JOIN riders r ON r.id=s."riderId" LEFT JOIN drivers d ON d.id=s."driverId"
  LEFT JOIN vendors v ON v.id=s."vendorId" LEFT JOIN vendor_owners vo ON vo.id=v."ownerId"
  JOIN users u ON u.id=COALESCE(r."userId", d."userId", vo."userId") WHERE s.id=p_subscription
$$;
ALTER TABLE billing_dunning_clocks ADD CONSTRAINT billing_clock_shape CHECK (
  epoch > 0 AND version >= 0 AND "elapsedMs" >= 0
  AND num_nonnulls("runningSince", "pausedAt")=1
  AND ("retryAtMs" IS NULL OR "retryAtMs">=0)
  AND ("nudgeAtMs" IS NULL OR "nudgeAtMs">=0)
  AND ("churnAtMs" IS NULL OR "churnAtMs">=0));
ALTER TABLE payment_confirmation_holds ADD CONSTRAINT confirmation_source_shape CHECK (
  num_nonnulls("paymentId", "checkoutId", "cardSessionId")=1 AND "sourceEpoch">0
  AND length(reason)>0 AND "reviewDueAt">="beganAt"
  AND ((status IN ('ACTIVE','SETTLEMENT_APPLY_PENDING') AND "resolvedAt" IS NULL AND "resolvedBy" IS NULL AND "resolutionEvidence" IS NULL)
    OR (status IN ('PAID','PROVEN_UNPAID','PROVEN_NO_EFFECT') AND "resolvedAt" IS NOT NULL
      AND length(btrim("resolvedBy"))>0 AND length(btrim("resolutionEvidence"))>0)));
ALTER TABLE billing_fee_notices ADD CONSTRAINT billing_notice_shape CHECK (
  epoch>0 AND length("stageKey")>0 AND status IN ('PENDING','DELIVERED','OBSOLETE'));
ALTER TABLE billing_notice_handoffs ADD CONSTRAINT billing_handoff_shape CHECK (
  length(channel)>0 AND length(part)>0 AND status IN ('PREPARED','UNKNOWN','DELIVERED','NOT_SENT'));

CREATE FUNCTION billing_clock_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_tenant text;
BEGIN
  SELECT "tenantId" INTO owner_tenant FROM billing_clock_payer(NEW."subscriptionId");
  IF owner_tenant IS NULL OR owner_tenant<>NEW."tenantId" THEN
    RAISE EXCEPTION 'Billing ownership unavailable' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='UPDATE' AND (NEW."subscriptionId"<>OLD."subscriptionId" OR NEW."tenantId"<>OLD."tenantId"
    OR (NEW."dueAt"<>OLD."dueAt" AND NOT (NEW.epoch=OLD.epoch+1 AND NEW."elapsedMs"=0))
    OR NEW.epoch<OLD.epoch OR NEW.epoch>OLD.epoch+1) THEN
    RAISE EXCEPTION 'Billing clock identity is immutable' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_clock_lineage BEFORE INSERT OR UPDATE ON billing_dunning_clocks
FOR EACH ROW EXECUTE FUNCTION billing_clock_lineage();

CREATE FUNCTION billing_confirmation_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c billing_dunning_clocks%ROWTYPE; source_sub text; source_tenant text; source_user text; payer_user text;
BEGIN
  SELECT * INTO c FROM billing_dunning_clocks WHERE "subscriptionId"=NEW."subscriptionId";
  IF c."subscriptionId" IS NULL OR c."tenantId"<>NEW."tenantId" OR NEW."sourceEpoch">c.epoch THEN
    RAISE EXCEPTION 'Confirmation ownership unavailable' USING ERRCODE='check_violation';
  END IF;
  IF NEW."paymentId" IS NOT NULL THEN
    SELECT p."subscriptionId" INTO source_sub FROM subscription_payments p WHERE p.id=NEW."paymentId"
      AND p."paymentMethod" IN ('CARD','MOBILE_MONEY') AND COALESCE(p."clientKey",'') NOT LIKE 'cardpay:%'
      AND NOT EXISTS (SELECT 1 FROM card_sessions cs WHERE cs."paymentId"=p.id);
    SELECT "tenantId" INTO source_tenant FROM billing_clock_payer(source_sub);
  ELSIF NEW."checkoutId" IS NOT NULL THEN
    SELECT "subscriptionId", "tenantId", "createdByUserId" INTO source_sub, source_tenant, source_user
    FROM mmg_checkout_intents WHERE id=NEW."checkoutId";
  ELSE
    SELECT "subscriptionId", "tenantId", "userId" INTO source_sub, source_tenant, source_user
    FROM card_sessions WHERE id=NEW."cardSessionId" AND purpose='PAY_NOW';
  END IF;
  SELECT "userId" INTO payer_user FROM billing_clock_payer(source_sub);
  IF source_sub IS DISTINCT FROM NEW."subscriptionId" OR source_tenant IS DISTINCT FROM NEW."tenantId"
    OR (source_user IS NOT NULL AND source_user IS DISTINCT FROM payer_user) THEN
    RAISE EXCEPTION 'Confirmation source unavailable' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='UPDATE' AND (
    (NEW."tenantId",NEW."subscriptionId",NEW."sourceEpoch",NEW."paymentId",NEW."checkoutId",NEW."cardSessionId",NEW."beganAt")
      IS DISTINCT FROM (OLD."tenantId",OLD."subscriptionId",OLD."sourceEpoch",OLD."paymentId",OLD."checkoutId",OLD."cardSessionId",OLD."beganAt")
    OR (OLD.status NOT IN ('ACTIVE','SETTLEMENT_APPLY_PENDING') AND NEW IS DISTINCT FROM OLD)) THEN
    RAISE EXCEPTION 'Confirmation evidence is immutable' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_confirmation_lineage BEFORE INSERT OR UPDATE ON payment_confirmation_holds
FOR EACH ROW EXECUTE FUNCTION billing_confirmation_lineage();

CREATE FUNCTION billing_notice_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_tenant text; parent_epoch integer; recipient_tenant text;
BEGIN
  IF TG_TABLE_NAME='billing_fee_notices' THEN
    SELECT "tenantId",epoch INTO owner_tenant,parent_epoch FROM billing_dunning_clocks WHERE "subscriptionId"=NEW."subscriptionId";
    SELECT "tenantId" INTO recipient_tenant FROM users WHERE id=NEW."userId";
    IF recipient_tenant IS DISTINCT FROM owner_tenant OR NEW.epoch>parent_epoch THEN
      RAISE EXCEPTION 'Fee notice recipient unavailable' USING ERRCODE='check_violation';
    END IF;
    IF TG_OP='UPDATE' AND (NEW."tenantId",NEW."subscriptionId",NEW.epoch,NEW."stageKey",NEW."userId",NEW.payload)
      IS DISTINCT FROM (OLD."tenantId",OLD."subscriptionId",OLD.epoch,OLD."stageKey",OLD."userId",OLD.payload) THEN
      RAISE EXCEPTION 'Fee notice identity is immutable' USING ERRCODE='check_violation';
    END IF;
  ELSE
    SELECT "tenantId" INTO owner_tenant FROM billing_fee_notices WHERE id=NEW."noticeId";
    IF TG_OP='UPDATE' AND ((NEW."tenantId",NEW."noticeId",NEW.channel,NEW.part)
      IS DISTINCT FROM (OLD."tenantId",OLD."noticeId",OLD.channel,OLD.part)
      OR (OLD.status='DELIVERED' AND NEW.status<>'DELIVERED')) THEN
      RAISE EXCEPTION 'Fee handoff identity is immutable' USING ERRCODE='check_violation';
    END IF;
  END IF;
  IF owner_tenant IS NULL OR owner_tenant<>NEW."tenantId" THEN
    RAISE EXCEPTION 'Fee notice ownership unavailable' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_notice_lineage BEFORE INSERT OR UPDATE ON billing_fee_notices FOR EACH ROW EXECUTE FUNCTION billing_notice_lineage();
CREATE TRIGGER billing_handoff_lineage BEFORE INSERT OR UPDATE ON billing_notice_handoffs FOR EACH ROW EXECUTE FUNCTION billing_notice_lineage();

-- Old API and billing writers must be stopped for this backfill and activation.
INSERT INTO billing_dunning_clocks ("subscriptionId","tenantId","dueAt","runningSince","retryAtMs","nudgeAtMs","churnAtMs","updatedAt")
SELECT s.id,p."tenantId",s."nextBillingDate",s."nextBillingDate",
  CASE WHEN s."nextRetryAt" IS NULL THEN 0 ELSE greatest(0,extract(epoch FROM (s."nextRetryAt"-s."nextBillingDate"))*1000)::bigint END,
  CASE WHEN s.status='SUSPENDED' THEN greatest(0,extract(epoch FROM (CURRENT_TIMESTAMP-s."nextBillingDate"))*1000)::bigint END,
  CASE WHEN s.status='SUSPENDED' THEN greatest(0,extract(epoch FROM (COALESCE(s."suspendedAt",s."updatedAt")+interval '30 days'-s."nextBillingDate"))*1000)::bigint END,
  CURRENT_TIMESTAMP FROM subscriptions s CROSS JOIN LATERAL billing_clock_payer(s.id) p;

WITH sources AS (
  SELECT c.id, c."subscriptionId",c."tenantId",c."createdAt",NULL::text AS payment,NULL::text AS card,c.id AS checkout,
    'MMG_CONFIRMATION_PENDING' AS reason FROM mmg_checkout_intents c WHERE c.status IN ('OPEN','CONFIRMING','HELD','EXPIRED')
  UNION ALL
  SELECT c.id,c."subscriptionId",c."tenantId",c."createdAt",NULL,c.id,NULL,'CARD_CONFIRMATION_PENDING'
    FROM card_sessions c WHERE c.purpose='PAY_NOW' AND c.status IN ('OPEN','UNKNOWN','HELD','EXPIRED')
  UNION ALL
  SELECT p.id,p."subscriptionId",c."tenantId",p."createdAt",p.id,NULL,NULL,'PAYMENT_CONFIRMATION_PENDING'
    FROM subscription_payments p JOIN billing_dunning_clocks c ON c."subscriptionId"=p."subscriptionId"
    WHERE p."paymentMethod" IN ('CARD','MOBILE_MONEY')
      AND (p.status IN ('UNKNOWN','PENDING') OR p."failureCode" IN ('REQUIRES_ACTION','AMOUNT_MISMATCH','SETTLEMENT_MISMATCH','HISTORY_APPROVAL_UNVERIFIED','CURRENCY_UNPINNED','WALLET_CURRENCY_MISMATCH','PROVIDER_NOT_FOUND'))
      AND COALESCE(p."failureRaw"->>'providerEffect','')<>'NOT_SENT'
      AND COALESCE(p."clientKey",'') NOT LIKE 'cardpay:%'
      AND NOT EXISTS (SELECT 1 FROM card_sessions cs WHERE cs."paymentId"=p.id)
)
INSERT INTO payment_confirmation_holds (id,"tenantId","subscriptionId","sourceEpoch","paymentId","checkoutId","cardSessionId",reason,"beganAt","reviewDueAt","updatedAt")
SELECT gen_random_uuid()::text,s."tenantId",s."subscriptionId",c.epoch,s.payment,s.checkout,s.card,s.reason,s."createdAt",s."createdAt"+interval '24 hours',CURRENT_TIMESTAMP
FROM sources s JOIN billing_dunning_clocks c ON c."subscriptionId"=s."subscriptionId";
UPDATE billing_dunning_clocks c SET "pausedAt"=h.first_at,"runningSince"=NULL,
  "elapsedMs"=greatest(0,extract(epoch FROM (h.first_at-c."dueAt"))*1000)::bigint
FROM (SELECT "subscriptionId",min("beganAt") first_at FROM payment_confirmation_holds GROUP BY "subscriptionId") h
WHERE c."subscriptionId"=h."subscriptionId";
UPDATE subscriptions s SET "billingConfirmationPausedAt"=c."pausedAt",
  "billingEnforcementDueAt"=CASE WHEN c."pausedAt" IS NULL THEN c."dueAt"+interval '48 hours' END,
  "gracePeriodEnd"=CASE WHEN c."pausedAt" IS NULL THEN c."dueAt"+interval '48 hours' END,
  "nextRetryAt"=CASE WHEN c."pausedAt" IS NULL AND c."retryAtMs" IS NOT NULL THEN c."dueAt"+(c."retryAtMs"*interval '1 millisecond') END
FROM billing_dunning_clocks c WHERE c."subscriptionId"=s.id;

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

REVOKE DELETE ON billing_dunning_clocks,payment_confirmation_holds,billing_fee_notices,billing_notice_handoffs FROM swift_app;

CREATE FUNCTION billing_confirmation_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='subscription_payments' THEN
    IF NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId" AND EXISTS (SELECT 1 FROM payment_confirmation_holds WHERE "paymentId"=OLD.id) THEN
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
