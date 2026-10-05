-- One future mover fee per same-tenant payer. Existing money/source rows stay put.
CREATE TYPE "MoverFeeAuthorityState" AS ENUM ('ACTIVE', 'FINANCE_HOLD');
CREATE UNIQUE INDEX "users_id_tenantId_key" ON "users"("id", "tenantId");
CREATE TABLE "mover_fee_authorities" (
  "userId" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "canonicalSubscriptionId" TEXT NOT NULL,
  "feeType" "SubscriptionType" NOT NULL,
  "state" "MoverFeeAuthorityState" NOT NULL DEFAULT 'ACTIVE',
  "holdReason" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "decisionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mover_fee_authorities_fee_type" CHECK ("feeType" IN ('TAXI_DRIVER','DELIVERY_RIDER','COURIER_RIDER')),
  CONSTRAINT "mover_fee_authorities_hold_reason" CHECK (("state" = 'ACTIVE' AND "holdReason" IS NULL) OR ("state" = 'FINANCE_HOLD' AND length(trim("holdReason")) > 0)),
  CONSTRAINT "mover_fee_authorities_revision" CHECK ("revision" > 0),
  CONSTRAINT "mover_fee_authorities_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "mover_fee_authorities_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "mover_fee_authorities_canonicalSubscriptionId_fkey" FOREIGN KEY ("canonicalSubscriptionId") REFERENCES "subscriptions"("id") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "mover_fee_authorities_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "audit_logs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "mover_fee_authorities_canonicalSubscriptionId_key" ON "mover_fee_authorities"("canonicalSubscriptionId");
CREATE UNIQUE INDEX "mover_fee_authorities_decisionId_key" ON "mover_fee_authorities"("decisionId");
CREATE UNIQUE INDEX "mover_fee_authorities_userId_tenantId_key" ON "mover_fee_authorities"("userId", "tenantId");
CREATE INDEX "mover_fee_authorities_tenantId_state_updatedAt_idx" ON "mover_fee_authorities"("tenantId", "state", "updatedAt");
CREATE TABLE "mover_fee_subscriptions" (
  "subscriptionId" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mover_fee_subscriptions_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "mover_fee_subscriptions_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "mover_fee_authorities"("userId", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "mover_fee_subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "mover_fee_subscriptions_userId_tenantId_idx" ON "mover_fee_subscriptions"("userId", "tenantId");
CREATE INDEX "mover_fee_subscriptions_tenantId_idx" ON "mover_fee_subscriptions"("tenantId");

-- Neither authority nor original membership can disappear while the payer
-- survives. Account erasure retains the payer and money rows; a separately
-- authorized full payer purge may cascade metadata with its existing rules.
CREATE FUNCTION mover_fee_preserve_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id = OLD."userId") THEN
      RAISE EXCEPTION 'mover fee authority and sources must survive their payer' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'mover fee payer and tenant are immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_TABLE_NAME = 'mover_fee_subscriptions' THEN
      IF NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId" THEN
        RAISE EXCEPTION 'mover fee source is immutable' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."revision" <> OLD."revision" + 1 OR NEW."decisionId" = OLD."decisionId" THEN
      RAISE EXCEPTION 'mover fee change requires a new audited revision' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mover_fee_authorities_preserve BEFORE UPDATE OR DELETE ON mover_fee_authorities FOR EACH ROW EXECUTE FUNCTION mover_fee_preserve_authority();
CREATE TRIGGER mover_fee_subscriptions_preserve BEFORE UPDATE OR DELETE ON mover_fee_subscriptions FOR EACH ROW EXECUTE FUNCTION mover_fee_preserve_authority();

-- Checked against final transaction state: create parent and memberships
-- atomically, and require same-payer original ownership and an audited choice.
CREATE FUNCTION mover_fee_validate_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payer_id TEXT; authority mover_fee_authorities%ROWTYPE; member RECORD; decision audit_logs%ROWTYPE;
BEGIN
  payer_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."userId" ELSE NEW."userId" END;
  SELECT * INTO authority FROM mover_fee_authorities WHERE "userId" = payer_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM mover_fee_subscriptions WHERE "subscriptionId" = authority."canonicalSubscriptionId" AND "userId" = payer_id AND "tenantId" = authority."tenantId") THEN
    RAISE EXCEPTION 'canonical mover fee must be a same-payer member' USING ERRCODE = 'check_violation';
  END IF;
  FOR member IN SELECT m."subscriptionId", s."riderId", s."driverId", s."vendorId", r."userId" AS rider_user, d."userId" AS driver_user
    FROM mover_fee_subscriptions m JOIN subscriptions s ON s.id = m."subscriptionId"
    LEFT JOIN riders r ON r.id = s."riderId" LEFT JOIN drivers d ON d.id = s."driverId" WHERE m."userId" = payer_id
  LOOP
    IF member."vendorId" IS NOT NULL OR num_nonnulls(member."riderId", member."driverId") <> 1 OR COALESCE(member.rider_user, member.driver_user) IS DISTINCT FROM payer_id THEN
      RAISE EXCEPTION 'mover fee source must retain exactly one original same-payer mover owner' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  SELECT * INTO decision FROM audit_logs WHERE id = authority."decisionId";
  IF NOT FOUND OR decision.entity <> 'MoverFeeAuthority' OR decision."entityId" <> payer_id
    OR decision.action NOT IN ('MOVER_FEE_CLASSIFIED','MOVER_FEE_ACTIVATED','MOVER_FEE_HELD','MOVER_FEE_RESOLVED')
    OR decision.changes->>'tenantId' IS DISTINCT FROM authority."tenantId"
    OR decision.changes->>'canonicalSubscriptionId' IS DISTINCT FROM authority."canonicalSubscriptionId"
    OR decision.changes->>'feeType' IS DISTINCT FROM authority."feeType"::text
    OR decision.changes->>'state' IS DISTINCT FROM authority.state::text
    OR decision.changes->>'holdReason' IS DISTINCT FROM authority."holdReason"
    OR decision.changes->>'revision' IS DISTINCT FROM authority.revision::text
    OR decision.changes->'sourceSubscriptionIds' IS DISTINCT FROM (SELECT jsonb_agg("subscriptionId" ORDER BY "subscriptionId") FROM mover_fee_subscriptions WHERE "userId" = payer_id)
  THEN RAISE EXCEPTION 'mover fee decision must audit the exact authority and source set' USING ERRCODE = 'check_violation'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER mover_fee_authorities_validate AFTER INSERT OR UPDATE ON mover_fee_authorities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mover_fee_validate_authority();
CREATE CONSTRAINT TRIGGER mover_fee_subscriptions_validate AFTER INSERT OR UPDATE OR DELETE ON mover_fee_subscriptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mover_fee_validate_authority();

-- A source or profile cannot be reparented behind an existing authority.
CREATE FUNCTION mover_fee_preserve_source_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'subscriptions' THEN
    IF EXISTS (SELECT 1 FROM mover_fee_subscriptions m JOIN users u ON u.id = m."userId" WHERE m."subscriptionId" = OLD.id)
      AND (NEW."riderId" IS DISTINCT FROM OLD."riderId" OR NEW."driverId" IS DISTINCT FROM OLD."driverId" OR NEW."vendorId" IS DISTINCT FROM OLD."vendorId" OR NEW.type IS DISTINCT FROM OLD.type) THEN
      RAISE EXCEPTION 'mover fee original subscription ownership is immutable' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."userId" IS DISTINCT FROM OLD."userId" AND EXISTS (
    SELECT 1 FROM mover_fee_subscriptions m JOIN users u ON u.id=m."userId" JOIN subscriptions s ON s.id=m."subscriptionId"
    WHERE (TG_TABLE_NAME='riders' AND s."riderId"=OLD.id) OR (TG_TABLE_NAME='drivers' AND s."driverId"=OLD.id)
  ) THEN RAISE EXCEPTION 'mover fee profile ownership is immutable' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mover_fee_source_owner BEFORE UPDATE OF "riderId", "driverId", "vendorId", type ON subscriptions FOR EACH ROW EXECUTE FUNCTION mover_fee_preserve_source_owner();
CREATE TRIGGER mover_fee_rider_owner BEFORE UPDATE OF "userId" ON riders FOR EACH ROW EXECUTE FUNCTION mover_fee_preserve_source_owner();
CREATE TRIGGER mover_fee_driver_owner BEFORE UPDATE OF "userId" ON drivers FOR EACH ROW EXECUTE FUNCTION mover_fee_preserve_source_owner();

ALTER TABLE mover_fee_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE mover_fee_authorities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mover_fee_authorities
 USING ("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'))
 WITH CHECK ("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'));
ALTER TABLE mover_fee_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mover_fee_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mover_fee_subscriptions
 USING ("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'))
 WITH CHECK ("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'));
GRANT SELECT, INSERT, UPDATE, DELETE ON mover_fee_authorities, mover_fee_subscriptions TO swift_app;
