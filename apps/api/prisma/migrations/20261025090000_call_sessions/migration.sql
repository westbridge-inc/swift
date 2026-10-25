-- [O-1 · owner 22-24 Oct 2026] The Swift call bridge: one row per call attempt on a live order.
-- EXPAND only: a new, empty table and its walls.
--
-- A row says who asked for the call (callerUserId + callerRole), which party they asked for
-- (calleeRole), the provider's id for the call, and how far it got. It NEVER holds a phone number:
-- both numbers are read from the order's own rows at the moment each leg is dialled and handed only
-- to the voice provider. INERT while CALL_RELAY is off: no row is ever written.
--
-- FORWARD
--  1. Table "call_sessions" (Prisma-shaped): FK to orders ON DELETE CASCADE (an attempt goes with its
--     order), FK to tenants, the tenantId / (orderId, createdAt) / callerUserId indexes and a unique
--     provider call id.
--  2. One live call per order: a partial unique index on orderId while endedAt is NULL. Two taps at
--     once start one call, never two (Swift pays for every attempt).
--  3. CHECKs on the new, empty table: the roles and statuses are the bridge's own words; a person
--     never calls their own role; CONNECTED exactly when connectedAt is set, and only after the caller
--     confirmed; a call that did not connect (NOT_CONNECTED / FAILED) is ended; seconds are never
--     negative.
--  4. The tenant wall: RLS ENABLED and FORCED, with the canonical policy. The text is
--     rlsDdlFor('call_sessions') from src/lib/tenant-rls.ts, byte for byte.
--  5. Tenant lineage: the row's tenant is its order's tenant. The text is the call_sessions rule of
--     tenantLineageDdl(), byte for byte (the taxi_ride_waiting shape).
--
-- ROLLBACK: rollback.sql beside this file (forward repair is preferred). Roll the application back
-- first: the previous application never reads this table. The guard refuses while any row exists
-- (the attempts are the record of calls Swift placed and paid for).

SET lock_timeout = '10s';

-- 1. The table (Prisma-shaped).
-- CreateTable
CREATE TABLE "call_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "orderId" TEXT NOT NULL,
    "callerUserId" TEXT NOT NULL,
    "callerRole" TEXT NOT NULL,
    "calleeRole" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCallId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DIALING_CALLER',
    "callerConfirmedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "call_sessions_providerCallId_key" ON "call_sessions"("providerCallId");

-- CreateIndex
CREATE INDEX "call_sessions_tenantId_idx" ON "call_sessions"("tenantId");

-- CreateIndex
CREATE INDEX "call_sessions_orderId_createdAt_idx" ON "call_sessions"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "call_sessions_callerUserId_idx" ON "call_sessions"("callerUserId");

-- AddForeignKey
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. One live call per order.
CREATE UNIQUE INDEX "call_sessions_one_live_per_order" ON "call_sessions"("orderId") WHERE "endedAt" IS NULL;

-- 3. The laws of a row.
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_roles_check"
  CHECK ("callerRole" IN ('customer', 'rider', 'driver', 'store')
     AND "calleeRole" IN ('customer', 'rider', 'driver', 'store', 'recipient')
     AND "calleeRole" <> "callerRole");
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_status_check"
  CHECK ("status" IN ('DIALING_CALLER', 'CALLER_CONFIRMED', 'CONNECTED', 'NOT_CONNECTED', 'FAILED'));
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_connected_law_check"
  CHECK (("status" = 'CONNECTED') = ("connectedAt" IS NOT NULL)
     AND ("connectedAt" IS NULL OR "callerConfirmedAt" IS NOT NULL));
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_ended_law_check"
  CHECK ("status" NOT IN ('NOT_CONNECTED', 'FAILED') OR "endedAt" IS NOT NULL);
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_numbers_check"
  CHECK (("durationSeconds" IS NULL OR "durationSeconds" >= 0) AND "provider" <> '');

-- 4. The tenant wall (rlsDdlFor('call_sessions')).
ALTER TABLE "call_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "call_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "call_sessions";
CREATE POLICY "tenant_isolation" ON "call_sessions"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- 5. Tenant lineage (tenantLineageDdl(), the call_sessions rule).
CREATE OR REPLACE FUNCTION call_sessions_tenant_matches_order() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM orders WHERE id = NEW."orderId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'call_sessions row % names orders row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."orderId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'call_sessions row % names tenant % but its orders row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."orderId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS call_sessions_tenant_matches_order ON call_sessions;

CREATE TRIGGER call_sessions_tenant_matches_order BEFORE INSERT OR UPDATE OF "tenantId", "orderId" ON call_sessions FOR EACH ROW EXECUTE FUNCTION call_sessions_tenant_matches_order();
