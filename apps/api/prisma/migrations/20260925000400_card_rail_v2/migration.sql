-- [PT-1] Card rail v2 foundation: partners pay Swift's weekly fee by card
-- through a provider-hosted page. Three new tables and one nullable column;
-- no existing row changes. Behind CARD_RAIL_V2 (default OFF).
--
--   payment_instruments  a card the partner enrolled: the provider's vault
--                        token SEALED at rest, brand / last 4 / expiry only,
--                        bound to the provider + environment + account that
--                        minted it [C2]; one ACTIVE per subscription.
--   card_sessions        one hosted session (ENROLL | PAY_NOW): the durable
--                        intent that exists before any provider page; one-use
--                        state kept as a sha256; one live per purpose [C6].
--   card_observations    APPEND-ONLY evidence of every provider answer: the
--                        raw payload's sha256 only, what Swift parsed, what
--                        Swift decided.
--   subscription_payments.instrumentId
--                        which instrument a weekly card intent charges, so
--                        retrieval goes to the provider that minted it.
SET lock_timeout = '10s';

-- 1. Prisma-shaped DDL (identical to `prisma migrate diff` for this schema).
-- CreateEnum
CREATE TYPE "PaymentInstrumentStatus" AS ENUM ('ACTIVE', 'REPLACED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CardSessionPurpose" AS ENUM ('ENROLL', 'PAY_NOW');

-- CreateEnum
CREATE TYPE "CardSessionStatus" AS ENUM ('OPEN', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'HELD');

-- CreateEnum
CREATE TYPE "CardObservationSource" AS ENUM ('RETURN', 'CONFIRM', 'CHARGE', 'RETRIEVE');

-- CreateEnum
CREATE TYPE "CardObservedStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'UNKNOWN', 'REQUIRES_ACTION', 'PENDING', 'INVALID');

-- CreateEnum
CREATE TYPE "CardObservationVerdict" AS ENUM ('ACCEPTED', 'REJECTED_STATE', 'REJECTED_USER', 'REJECTED_TENANT', 'REJECTED_PURPOSE', 'REJECTED_EXPIRED', 'REJECTED_REPLAY', 'REJECTED_CLOSED', 'REJECTED_BINDING', 'REJECTED_MISMATCH');

-- AlterTable
ALTER TABLE "subscription_payments" ADD COLUMN     "instrumentId" TEXT;

-- CreateTable
CREATE TABLE "payment_instruments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "subscriptionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "providerAccount" TEXT NOT NULL,
    "vaultTokenSealed" BYTEA NOT NULL,
    "vaultTokenDek" BYTEA NOT NULL,
    "brand" TEXT NOT NULL,
    "last4" CHAR(4) NOT NULL,
    "expMonth" INTEGER NOT NULL,
    "expYear" INTEGER NOT NULL,
    "status" "PaymentInstrumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "consentVersion" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "replacedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "subscriptionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "CardSessionPurpose" NOT NULL,
    "status" "CardSessionStatus" NOT NULL DEFAULT 'OPEN',
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "providerAccount" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    "currencyCode" TEXT,
    "periodStart" TIMESTAMP(3),
    "stateHash" CHAR(64) NOT NULL,
    "idempotencyKey" TEXT,
    "providerSessionRef" TEXT,
    "hostedUrl" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "returnedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "consentVersion" TEXT,
    "consentAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "instrumentId" TEXT,
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_observations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "source" "CardObservationSource" NOT NULL,
    "sessionId" TEXT,
    "subscriptionId" TEXT,
    "instrumentId" TEXT,
    "paymentId" TEXT,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "rawSha256" CHAR(64) NOT NULL,
    "parsedStatus" "CardObservedStatus" NOT NULL,
    "verdict" "CardObservationVerdict" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_instruments_tenantId_idx" ON "payment_instruments"("tenantId");

-- CreateIndex
CREATE INDEX "payment_instruments_subscriptionId_status_idx" ON "payment_instruments"("subscriptionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "card_sessions_instrumentId_key" ON "card_sessions"("instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "card_sessions_paymentId_key" ON "card_sessions"("paymentId");

-- CreateIndex
CREATE INDEX "card_sessions_tenantId_idx" ON "card_sessions"("tenantId");

-- CreateIndex
CREATE INDEX "card_sessions_status_expiresAt_idx" ON "card_sessions"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "card_sessions_subscriptionId_purpose_idempotencyKey_key" ON "card_sessions"("subscriptionId", "purpose", "idempotencyKey");

-- CreateIndex
CREATE INDEX "card_observations_tenantId_idx" ON "card_observations"("tenantId");

-- CreateIndex
CREATE INDEX "card_observations_sessionId_idx" ON "card_observations"("sessionId");

-- CreateIndex
CREATE INDEX "card_observations_subscriptionId_createdAt_idx" ON "card_observations"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "subscription_payments_instrumentId_idx" ON "subscription_payments"("instrumentId");

-- AddForeignKey
ALTER TABLE "payment_instruments" ADD CONSTRAINT "payment_instruments_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_sessions" ADD CONSTRAINT "card_sessions_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. The row laws Prisma cannot express.
-- [C9] Display facts only: four digits, a real month, a four-digit year.
ALTER TABLE "payment_instruments" ADD CONSTRAINT "payment_instruments_display_check"
  CHECK ("last4" ~ '^[0-9]{4}$' AND "expMonth" BETWEEN 1 AND 12 AND "expYear" BETWEEN 2000 AND 2199);
-- [C2] A binding names a provider, a sandbox-or-live environment and an account label.
ALTER TABLE "payment_instruments" ADD CONSTRAINT "payment_instruments_binding_check"
  CHECK ("provider" ~ '^[a-z][a-z0-9_-]{0,31}$' AND "environment" IN ('sandbox', 'live') AND char_length("providerAccount") BETWEEN 1 AND 64);
-- The token is sealed (iv + tag + ciphertext) and its data key is WRAPPED: a
-- raw AES-256 key is exactly 32 bytes, so a stored key of 32 bytes or fewer
-- would be an unwrapped one. A vault token is never kept under an unwrapped key.
ALTER TABLE "payment_instruments" ADD CONSTRAINT "payment_instruments_sealed_check"
  CHECK (octet_length("vaultTokenSealed") > 28 AND octet_length("vaultTokenDek") > 32);
ALTER TABLE "payment_instruments" ADD CONSTRAINT "payment_instruments_status_time_check"
  CHECK (("status" <> 'REPLACED' OR "replacedAt" IS NOT NULL)
     AND ("status" <> 'REVOKED' OR "revokedAt" IS NOT NULL)
     AND ("status" <> 'EXPIRED' OR "expiredAt" IS NOT NULL));

ALTER TABLE "card_sessions" ADD CONSTRAINT "card_sessions_binding_check"
  CHECK ("provider" ~ '^[a-z][a-z0-9_-]{0,31}$' AND "environment" IN ('sandbox', 'live') AND char_length("providerAccount") BETWEEN 1 AND 64);
ALTER TABLE "card_sessions" ADD CONSTRAINT "card_sessions_state_hash_check"
  CHECK ("stateHash" ~ '^[0-9a-f]{64}$');
-- A PAY_NOW session carries the server-priced amount, its currency and the
-- week it pays; an ENROLL session carries none of them and must carry consent.
ALTER TABLE "card_sessions" ADD CONSTRAINT "card_sessions_purpose_shape_check"
  CHECK (("purpose" = 'PAY_NOW' AND "amount" IS NOT NULL AND "amount" > 0 AND "currencyCode" IS NOT NULL AND "periodStart" IS NOT NULL)
      OR ("purpose" = 'ENROLL' AND "amount" IS NULL AND "currencyCode" IS NULL AND "periodStart" IS NULL
          AND "consentVersion" IS NOT NULL AND "consentAt" IS NOT NULL));
-- An ISO-4217 alpha code, refused at write time rather than at the provider seam.
ALTER TABLE "card_sessions" ADD CONSTRAINT "card_sessions_currency_check"
  CHECK ("currencyCode" IS NULL OR "currencyCode" ~ '^[A-Z]{3}$');

ALTER TABLE "card_observations" ADD CONSTRAINT "card_observations_digest_check"
  CHECK ("rawSha256" ~ '^[0-9a-f]{64}$');

-- 3. [C6] One ACTIVE instrument per subscription; one live (OPEN or UNKNOWN)
--    session per subscription and purpose.
CREATE UNIQUE INDEX "payment_instruments_one_active_per_subscription" ON "payment_instruments"("subscriptionId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "card_sessions_one_live_per_purpose" ON "card_sessions"("subscriptionId", "purpose") WHERE "status" IN ('OPEN', 'UNKNOWN');

-- 4. [C2] An instrument's binding, token and card facts are frozen once
--    written: no configuration change or later write can re-rail a token to
--    another provider, environment or account. Status moves only out of
--    ACTIVE, a terminal status never moves again, and the facts of how it
--    left service (replaced by what and when, revoked by whom and when,
--    expired when) are written once and never rewritten.
CREATE OR REPLACE FUNCTION payment_instruments_frozen() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
           OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
           OR NEW."userId" IS DISTINCT FROM OLD."userId"
           OR NEW."provider" IS DISTINCT FROM OLD."provider"
           OR NEW."environment" IS DISTINCT FROM OLD."environment"
           OR NEW."providerAccount" IS DISTINCT FROM OLD."providerAccount"
           OR NEW."vaultTokenSealed" IS DISTINCT FROM OLD."vaultTokenSealed"
           OR NEW."vaultTokenDek" IS DISTINCT FROM OLD."vaultTokenDek"
           OR NEW."brand" IS DISTINCT FROM OLD."brand"
           OR NEW."last4" IS DISTINCT FROM OLD."last4"
           OR NEW."expMonth" IS DISTINCT FROM OLD."expMonth"
           OR NEW."expYear" IS DISTINCT FROM OLD."expYear"
           OR NEW."consentVersion" IS DISTINCT FROM OLD."consentVersion"
           OR NEW."consentAt" IS DISTINCT FROM OLD."consentAt"
           OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
          RAISE EXCEPTION 'payment_instruments row % is frozen: its binding, token and card facts never change once written [PT-1 C2]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF (OLD."replacedAt" IS NOT NULL AND NEW."replacedAt" IS DISTINCT FROM OLD."replacedAt")
           OR (OLD."replacedById" IS NOT NULL AND NEW."replacedById" IS DISTINCT FROM OLD."replacedById")
           OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt")
           OR (OLD."revokedBy" IS NOT NULL AND NEW."revokedBy" IS DISTINCT FROM OLD."revokedBy")
           OR (OLD."expiredAt" IS NOT NULL AND NEW."expiredAt" IS DISTINCT FROM OLD."expiredAt") THEN
          RAISE EXCEPTION 'payment_instruments row %: how it left service is written once and never rewritten [PT-1]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF OLD."status" <> 'ACTIVE' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
          RAISE EXCEPTION 'payment_instruments row % is %: a terminal instrument never changes status [PT-1]',
            OLD.id, OLD."status" USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payment_instruments_frozen ON payment_instruments;
CREATE TRIGGER payment_instruments_frozen BEFORE UPDATE ON payment_instruments FOR EACH ROW EXECUTE FUNCTION payment_instruments_frozen();

-- A card leaves service through REVOKED or EXPIRED, never by DELETE: the row
-- holds the binding, the sealed token and the consent that payments name.
-- The one DELETE that passes is the cascade of its own subscription's
-- deletion — the same cascade that takes that subscription's payments and
-- billing events, so nothing is left naming a card that no longer exists.
-- That DELETE arrives from the foreign key's cascade trigger (nesting depth
-- 2); every direct DELETE runs at depth 1 and is refused.
CREATE OR REPLACE FUNCTION payment_instruments_no_delete() RETURNS trigger AS $$
      BEGIN
        IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE id = OLD."subscriptionId") THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'payment_instruments row % cannot be deleted: a card leaves service through REVOKED or EXPIRED [PT-1]',
          OLD.id USING ERRCODE = 'check_violation';
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payment_instruments_no_delete ON payment_instruments;
CREATE TRIGGER payment_instruments_no_delete BEFORE DELETE ON payment_instruments FOR EACH ROW EXECUTE FUNCTION payment_instruments_no_delete();

-- [C8] A session is bound for life: its payer, subscription, purpose,
--    binding, price, state and window never change. Its one-use markers —
--    the accepted return, the confirmation, the instrument or payment it
--    produced, the provider's page — move from empty to a value once and
--    never again. A terminal session never moves again; HELD waits for a
--    person and may only be resolved.
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
        IF OLD."status" IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
          RAISE EXCEPTION 'card_sessions row % is %: a terminal session never changes status [PT-1]',
            OLD.id, OLD."status" USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS card_sessions_frozen ON card_sessions;
CREATE TRIGGER card_sessions_frozen BEFORE UPDATE ON card_sessions FOR EACH ROW EXECUTE FUNCTION card_sessions_frozen();

-- 5. Observations are evidence: append-only, like consent_records.
REVOKE UPDATE, DELETE ON "card_observations" FROM PUBLIC;
CREATE OR REPLACE FUNCTION card_observations_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'card_observations is append-only [PT-1]: a new observation is a new row' USING ERRCODE = 'check_violation';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS card_observations_no_mutation ON card_observations;
CREATE TRIGGER card_observations_no_mutation
  BEFORE UPDATE OR DELETE ON "card_observations"
  FOR EACH ROW EXECUTE FUNCTION card_observations_block_mutation();

-- 6. The tenant wall on all three (enabled AND forced). Text = rlsDdlFor(<table>).
ALTER TABLE "payment_instruments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_instruments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "payment_instruments";
CREATE POLICY "tenant_isolation" ON "payment_instruments"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

ALTER TABLE "card_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "card_sessions";
CREATE POLICY "tenant_isolation" ON "card_sessions"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

ALTER TABLE "card_observations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_observations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "card_observations";
CREATE POLICY "tenant_isolation" ON "card_observations"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- 7. [STA-1 lineage] A row's tenant IS its payer's. Text = tenantLineageDdl()
--    for the three rules in src/lib/tenant-rls.ts (the test installer heals
--    db-push environments with the same text). Instruments and sessions
--    inherit through userId (the transactions/payouts shape); an observation
--    inherits its session, or, for an off-session charge that has no
--    session, the instrument it charged.
CREATE OR REPLACE FUNCTION payment_instruments_tenant_matches_user() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM users WHERE id = NEW."userId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'payment_instruments row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."userId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'payment_instruments row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."userId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payment_instruments_tenant_matches_user ON payment_instruments;
CREATE TRIGGER payment_instruments_tenant_matches_user BEFORE INSERT OR UPDATE OF "tenantId", "userId" ON payment_instruments FOR EACH ROW EXECUTE FUNCTION payment_instruments_tenant_matches_user();
CREATE OR REPLACE FUNCTION card_sessions_tenant_matches_user() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM users WHERE id = NEW."userId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'card_sessions row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."userId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'card_sessions row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."userId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS card_sessions_tenant_matches_user ON card_sessions;
CREATE TRIGGER card_sessions_tenant_matches_user BEFORE INSERT OR UPDATE OF "tenantId", "userId" ON card_sessions FOR EACH ROW EXECUTE FUNCTION card_sessions_tenant_matches_user();
CREATE OR REPLACE FUNCTION card_observations_tenant_matches_owner() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT COALESCE((SELECT s."tenantId" FROM card_sessions s WHERE s.id = NEW."sessionId"), (SELECT i."tenantId" FROM payment_instruments i WHERE i.id = NEW."instrumentId")) INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'card_observations row % names card_sessions row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."sessionId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'card_observations row % names tenant % but its card_sessions row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."sessionId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS card_observations_tenant_matches_owner ON card_observations;
CREATE TRIGGER card_observations_tenant_matches_owner BEFORE INSERT OR UPDATE OF "tenantId", "sessionId", "instrumentId" ON card_observations FOR EACH ROW EXECUTE FUNCTION card_observations_tenant_matches_owner();
