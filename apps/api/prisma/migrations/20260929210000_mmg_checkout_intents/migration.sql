-- [MMG checkout 2/6] A partner's attempt to pay the weekly fee on the MMG
-- hosted page, and every reply, callback and lookup observed for it.
-- Additive: two new tables, no change to any existing row. Nothing here credits
-- money: the credit is the provider_payments compare-and-set, taken only after
-- the MMG lookup confirms the exact amount, currency and merchant.
SET lock_timeout = '10s';

CREATE TABLE "mmg_checkout_intents" (
    "id"                    TEXT NOT NULL,
    "tenantId"              TEXT NOT NULL DEFAULT 'swift-default',
    "subscriptionId"        TEXT NOT NULL,
    "merchantTransactionId" TEXT NOT NULL,
    "amount"                DECIMAL(12,2) NOT NULL,
    "currencyCode"          CHAR(3) NOT NULL,
    "status"                TEXT NOT NULL DEFAULT 'OPEN',
    "clientKey"             TEXT NOT NULL,
    "createdByUserId"       TEXT NOT NULL,
    "platform"              TEXT NOT NULL,
    "checkoutUrl"           TEXT NOT NULL,
    "expiresAt"             TIMESTAMP(3) NOT NULL,
    "replyAt"               TIMESTAMP(3),
    "outcomeHint"           TEXT,
    "candidates"            TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mmgTransactionId"      TEXT,
    "providerPaymentId"     TEXT,
    "confirmedAt"           TIMESTAMP(3),
    "reason"                TEXT,
    "checkAttempts"         INTEGER NOT NULL DEFAULT 0,
    "nextCheckAt"           TIMESTAMP(3),
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mmg_checkout_intents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mmg_checkout_intents_status_check"
      CHECK ("status" IN ('OPEN', 'CONFIRMING', 'CONFIRMED', 'NOT_PAID', 'EXPIRED', 'HELD')),
    -- [I1] MMG takes whole dollars: what was asked for is a positive whole amount.
    CONSTRAINT "mmg_checkout_intents_amount_check" CHECK ("amount" > 0 AND "amount" = trunc("amount")),
    CONSTRAINT "mmg_checkout_intents_reference_check" CHECK ("merchantTransactionId" ~ '^[0-9]{18}$'),
    -- A confirmed checkout names the MMG transaction and the identity that credited it.
    CONSTRAINT "mmg_checkout_intents_confirmed_check"
      CHECK ("status" <> 'CONFIRMED' OR ("mmgTransactionId" IS NOT NULL AND "providerPaymentId" IS NOT NULL AND "confirmedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "mmg_checkout_intents_merchantTransactionId_key" ON "mmg_checkout_intents"("merchantTransactionId");
CREATE UNIQUE INDEX "mmg_checkout_intents_mmgTransactionId_key" ON "mmg_checkout_intents"("mmgTransactionId");
CREATE UNIQUE INDEX "mmg_checkout_intents_providerPaymentId_key" ON "mmg_checkout_intents"("providerPaymentId");
CREATE UNIQUE INDEX "mmg_checkout_intents_createdByUserId_clientKey_key" ON "mmg_checkout_intents"("createdByUserId", "clientKey");
CREATE INDEX "mmg_checkout_intents_tenantId_idx" ON "mmg_checkout_intents"("tenantId");
CREATE INDEX "mmg_checkout_intents_subscriptionId_createdAt_idx" ON "mmg_checkout_intents"("subscriptionId", "createdAt");
CREATE INDEX "mmg_checkout_intents_status_nextCheckAt_idx" ON "mmg_checkout_intents"("status", "nextCheckAt");
-- [I4] One open checkout per subscription. Prisma cannot express a partial
-- unique, so it lives here; constraint-dependent tests self-install the same text.
CREATE UNIQUE INDEX "mmg_checkout_intents_one_open_per_subscription"
  ON "mmg_checkout_intents"("subscriptionId") WHERE "status" IN ('OPEN', 'CONFIRMING');

CREATE TABLE "mmg_checkout_observations" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL DEFAULT 'swift-default',
    "intentId"  TEXT,
    "source"    TEXT NOT NULL,
    "detail"    TEXT,
    "body"      JSONB,
    "shape"     JSONB,
    "failure"   TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mmg_checkout_observations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mmg_checkout_observations_source_check" CHECK ("source" IN ('RETURN', 'NOTIFY', 'LOOKUP'))
);
CREATE INDEX "mmg_checkout_observations_tenantId_idx" ON "mmg_checkout_observations"("tenantId");
CREATE INDEX "mmg_checkout_observations_intentId_createdAt_idx" ON "mmg_checkout_observations"("intentId", "createdAt");

-- [W-201] Tenant isolation, the canonical predicate (rlsDdlFor): the bypass is
-- a ROLE, never a GUC a session could set on itself; FORCE binds the owner too.
ALTER TABLE "mmg_checkout_intents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mmg_checkout_intents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mmg_checkout_intents";
CREATE POLICY "tenant_isolation" ON "mmg_checkout_intents"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "mmg_checkout_observations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mmg_checkout_observations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mmg_checkout_observations";
CREATE POLICY "tenant_isolation" ON "mmg_checkout_observations"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
