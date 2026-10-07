-- [AF-MOB-006 · S0] CUSTODY-RECOVERY: one owned recovery case per delivery that goes wrong after pickup.
--
-- Before this, a rider holding the goods (and, on cash, the float fronted to the store) had one answer
-- when the delivery could not be finished: "Call support". Nothing recorded who owned the problem, by
-- when, or how it ended. This table is that record. Rules and edges live in
-- src/modules/order/order-status.ts (CUSTODY_CASE_LAW / CUSTODY_CASE_TRANSITIONS); the kernel is
-- src/modules/custody/custody-recovery.ts.
--
-- FORWARD
--  1. Enums "CustodyRecoveryState" and "CustodyIncidentReason", table "custody_recovery_cases"
--     (Prisma-shaped): FK to orders ON DELETE CASCADE, FK to tenants, the tenantId index.
--  2. One OPEN case per order: a partial unique index on orderId WHERE "resolvedAt" IS NULL.
--  3. The open/resolved law held by the database: "resolvedAt" IS NULL exactly when the state is one of
--     the four open states (mirrors CUSTODY_CASE_LAW; the schema suite grades the two against each other).
--     Plus: a transfer code exists only while a transfer is in progress, always with its own expiry, and
--     attempts are never negative.
--  4. The tenant wall: RLS ENABLED and FORCED with the canonical policy (rlsDdlFor('custody_recovery_cases')).
--  5. Tenant lineage: a case's tenant is its order's tenant (tenantLineageDdl(), byte for byte).
--  6. Identity freeze: id, tenantId and orderId never change once written.
--
-- New, empty table; nothing existing is touched or scanned.
--
-- ROLLBACK (forward repair is preferred). Roll the application back first. The guard refuses while any
-- case exists, because the custody history would be lost.
--   BEGIN;
--   SET LOCAL lock_timeout = '10s';
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM "custody_recovery_cases") THEN
--       RAISE EXCEPTION 'refusing rollback: custody recovery cases exist';
--     END IF;
--   END $$;
--   DROP TABLE "custody_recovery_cases";
--   DROP FUNCTION custody_recovery_cases_tenant_matches_order();
--   DROP FUNCTION custody_recovery_cases_identity_frozen();
--   DROP TYPE "CustodyRecoveryState";
--   DROP TYPE "CustodyIncidentReason";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261005120000_custody_recovery_cases';
--   COMMIT;

SET lock_timeout = '10s';

-- 1. Prisma-shaped objects.
-- CreateEnum
CREATE TYPE "CustodyRecoveryState" AS ENUM ('SUPPORT_HOLD', 'RETURN_REQUIRED', 'RELAY_REQUIRED', 'TRANSFER_IN_PROGRESS', 'DELIVERED', 'RETURNED', 'TRANSFERRED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CustodyIncidentReason" AS ENUM ('VEHICLE_BREAKDOWN', 'CRASH', 'MEDICAL', 'UNSAFE_RECIPIENT', 'RECIPIENT_ABSENT', 'INACCESSIBLE_PROPERTY', 'DAMAGED_OR_PROHIBITED', 'WRONG_PACKAGE', 'POLICE_OR_ROAD_CLOSURE', 'DEVICE_FAILURE', 'OTHER', 'MOVER_SIGNAL_LOST', 'MOVER_SESSION_ENDED', 'RETURN_STARTED');

-- CreateTable
CREATE TABLE "custody_recovery_cases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "orderId" TEXT NOT NULL,
    "state" "CustodyRecoveryState" NOT NULL DEFAULT 'SUPPORT_HOLD',
    "reason" "CustodyIncidentReason" NOT NULL,
    "reasonNote" TEXT,
    "openedBy" TEXT,
    "holderRiderId" TEXT NOT NULL,
    "relayRiderId" TEXT,
    "transferCode" TEXT,
    "transferCodeExpiresAt" TIMESTAMP(3),
    "transferAttempts" INTEGER NOT NULL DEFAULT 0,
    "ownerUserId" TEXT,
    "ownerAssignedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "escalationCount" INTEGER NOT NULL DEFAULT 0,
    "lastEscalatedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "incidentLat" DOUBLE PRECISION,
    "incidentLng" DOUBLE PRECISION,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custody_recovery_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custody_recovery_cases_tenantId_idx" ON "custody_recovery_cases"("tenantId");

-- CreateIndex
CREATE INDEX "custody_recovery_cases_orderId_idx" ON "custody_recovery_cases"("orderId");

-- CreateIndex
CREATE INDEX "custody_recovery_cases_state_deadlineAt_idx" ON "custody_recovery_cases"("state", "deadlineAt");

-- CreateIndex
CREATE INDEX "custody_recovery_cases_relayRiderId_idx" ON "custody_recovery_cases"("relayRiderId");

-- AddForeignKey
ALTER TABLE "custody_recovery_cases" ADD CONSTRAINT "custody_recovery_cases_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custody_recovery_cases" ADD CONSTRAINT "custody_recovery_cases_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. One open case per order.
CREATE UNIQUE INDEX "custody_recovery_cases_one_open_per_order" ON "custody_recovery_cases"("orderId") WHERE "resolvedAt" IS NULL;

-- 3. The open/resolved law, the transfer-code window, and a sane attempt counter.
ALTER TABLE "custody_recovery_cases" ADD CONSTRAINT "custody_recovery_cases_open_law_check"
  CHECK (("resolvedAt" IS NULL) = ("state" IN ('SUPPORT_HOLD', 'RETURN_REQUIRED', 'RELAY_REQUIRED', 'TRANSFER_IN_PROGRESS')));
ALTER TABLE "custody_recovery_cases" ADD CONSTRAINT "custody_recovery_cases_transfer_code_check"
  CHECK ("transferCode" IS NULL OR ("state" = 'TRANSFER_IN_PROGRESS' AND "relayRiderId" IS NOT NULL));
-- A code always carries its own expiry, and an expiry never outlives its code.
ALTER TABLE "custody_recovery_cases" ADD CONSTRAINT "custody_recovery_cases_code_expiry_check"
  CHECK (("transferCode" IS NULL) = ("transferCodeExpiresAt" IS NULL));
ALTER TABLE "custody_recovery_cases" ADD CONSTRAINT "custody_recovery_cases_attempts_check"
  CHECK ("transferAttempts" >= 0 AND "escalationCount" >= 0 AND "version" >= 0);

-- 4. The wall, on the row itself (enabled AND forced). Text = rlsDdlFor('custody_recovery_cases').
ALTER TABLE "custody_recovery_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custody_recovery_cases" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "custody_recovery_cases";
CREATE POLICY "tenant_isolation" ON "custody_recovery_cases"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- 5. Lineage held by the database. Text mirrored by tenantLineageDdl() in src/lib/tenant-rls.ts.
CREATE OR REPLACE FUNCTION custody_recovery_cases_tenant_matches_order() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM orders WHERE id = NEW."orderId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'custody_recovery_cases row % names orders row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."orderId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'custody_recovery_cases row % names tenant % but its orders row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."orderId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS custody_recovery_cases_tenant_matches_order ON custody_recovery_cases;
CREATE TRIGGER custody_recovery_cases_tenant_matches_order BEFORE INSERT OR UPDATE OF "tenantId", "orderId" ON custody_recovery_cases FOR EACH ROW EXECUTE FUNCTION custody_recovery_cases_tenant_matches_order();

-- 6. A case is about one order, for ever: it is never moved to another order or tenant.
CREATE OR REPLACE FUNCTION custody_recovery_cases_identity_frozen() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
           OR NEW."orderId" IS DISTINCT FROM OLD."orderId" THEN
          RAISE EXCEPTION 'custody_recovery_cases row % is frozen: id, tenantId and orderId never change once written [AF-MOB-006]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS custody_recovery_cases_identity_frozen ON custody_recovery_cases;
CREATE TRIGGER custody_recovery_cases_identity_frozen BEFORE UPDATE ON custody_recovery_cases FOR EACH ROW EXECUTE FUNCTION custody_recovery_cases_identity_frozen();
