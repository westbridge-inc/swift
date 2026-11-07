-- ROLLBACK for 20261029030000_pro_subscription_owner (BILL-PRO PR1: a pro can own a weekly-fee subscription).
--
-- Forward repair is preferred. Roll the application back first. The guard refuses while any pro
-- subscription exists: its fee history would lose its owner. PostgreSQL cannot drop an enum value
-- without rebuilding the type, so INDEPENDENT_PRO stays in "SubscriptionType" (inert: the guard
-- proves no row uses it). Every replaced function is restored to its previously shipped text.
BEGIN;
-- subscriptions and the billing tables force row-level security: without this, a role that does not
-- bypass it sees no rows and the guard passes blind. With it, such a role gets an error instead.
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM subscriptions WHERE "serviceProviderId" IS NOT NULL OR type::text = 'INDEPENDENT_PRO') THEN
    RAISE EXCEPTION 'PRO_SUBSCRIPTIONS_IN_USE: a pro subscription exists; its fee history would lose its owner; not rolling back';
  END IF;
END $guard$;

-- Collection contacts (as shipped by 20261013221500).
CREATE OR REPLACE FUNCTION collection_contacts_tenant_matches_owner() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT CASE WHEN count(DISTINCT owners.t) = 1 THEN min(owners.t) END FROM (SELECT v."tenantId" AS t FROM subscriptions s JOIN vendors v ON v.id = s."vendorId" WHERE s.id = NEW."subscriptionId" UNION ALL SELECT u."tenantId" FROM subscriptions s JOIN riders r ON r.id = s."riderId" JOIN users u ON u.id = r."userId" WHERE s.id = NEW."subscriptionId" UNION ALL SELECT u."tenantId" FROM subscriptions s JOIN drivers d ON d.id = s."driverId" JOIN users u ON u.id = d."userId" WHERE s.id = NEW."subscriptionId") owners INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'collection_contacts row % names subscriptions row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."subscriptionId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" IS NULL OR (NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default') THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'collection_contacts row % names tenant % but its subscriptions row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."subscriptionId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

-- MMG payer evidence (as shipped by 20260930201000).
CREATE OR REPLACE FUNCTION safeb_payer_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM users WHERE id=NEW."accountId" AND "tenantId"=NEW."tenantId") THEN RAISE EXCEPTION 'payer account lineage mismatch'; END IF;
 IF NEW."subscriptionId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM subscriptions s LEFT JOIN riders r ON r.id=s."riderId" LEFT JOIN drivers d ON d.id=s."driverId"
   LEFT JOIN vendors v ON v.id=s."vendorId" LEFT JOIN vendor_owners vo ON vo.id=v."ownerId"
   WHERE s.id=NEW."subscriptionId" AND NEW."accountId"=COALESCE(r."userId",d."userId",vo."userId")
 ) THEN RAISE EXCEPTION 'payer subscription mismatch'; END IF;
 RETURN NEW;
END $$;

-- Billing clock lineage (as shipped by 20260930180000).
DROP TRIGGER billing_parent_lineage ON service_providers;
DROP TRIGGER billing_parent_lineage ON subscriptions;
CREATE CONSTRAINT TRIGGER billing_parent_lineage AFTER UPDATE ON subscriptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((OLD."riderId",OLD."driverId",OLD."vendorId") IS DISTINCT FROM (NEW."riderId",NEW."driverId",NEW."vendorId")) EXECUTE FUNCTION billing_preserve_parent_lineage();
CREATE OR REPLACE FUNCTION billing_confirmation_missing_coverage() RETURNS bigint LANGUAGE sql STABLE AS $$
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
CREATE OR REPLACE FUNCTION billing_clock_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION billing_clock_payer(p_subscription text)
RETURNS TABLE ("userId" text, "tenantId" text) LANGUAGE sql STABLE AS $$
  SELECT u.id,u."tenantId" FROM subscriptions s
  LEFT JOIN riders r ON r.id=s."riderId" LEFT JOIN drivers d ON d.id=s."driverId"
  LEFT JOIN vendors v ON v.id=s."vendorId" LEFT JOIN vendor_owners vo ON vo.id=v."ownerId"
  JOIN users u ON u.id=COALESCE(r."userId",d."userId",vo."userId")
  WHERE s.id=p_subscription AND num_nonnulls(s."riderId",s."driverId",s."vendorId")=1
    AND (v.id IS NULL OR v."tenantId"=u."tenantId")
$$;

DROP TRIGGER pro_subscription_owner_fixed ON service_providers;
DROP TRIGGER pro_subscription_owner_fixed ON subscriptions;
DROP FUNCTION pro_subscription_owner_fixed();
DROP TRIGGER subscriptions_owner_at_birth ON subscriptions;
DROP FUNCTION subscriptions_owner_at_birth();
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_pro_owner_shape;
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_at_most_one_owner;
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_serviceProviderId_fkey";
DROP INDEX "subscriptions_serviceProviderId_key";
ALTER TABLE "subscriptions" DROP COLUMN "serviceProviderId";

DO $ledger$
DECLARE n integer;
BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029030000_pro_subscription_owner';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
