-- [BOOK-FU2 · owner B3, 28 Oct 2026] "Customer didn't come": the business records in the app that the customer did not
-- come to an appointment it had accepted, after its start. EXPAND only: a new, empty table and its walls.
--
-- A row holds ONLY which booking it was (bookingId), when the business recorded it (recordedAt) and who at the
-- business recorded it (recordedByUserId), on its order (one per order). It carries no fee and no strike; a person
-- at Swift reviews repeated cases. Kept with its order's record (Privacy Policy section 6).
--
-- FORWARD
--  1. Table "appointment_no_shows" (Prisma-shaped): FK to orders ON DELETE CASCADE (the record goes with its order),
--     FK to tenants, the tenantId index and one record per order (unique orderId).
--  2. The tenant wall: RLS ENABLED and FORCED, with the canonical policy. The text is
--     rlsDdlFor('appointment_no_shows') from src/lib/tenant-rls.ts, byte for byte.
--  3. Tenant lineage: the row's tenant is its order's tenant. The text is the appointment_no_shows rule of
--     tenantLineageDdl(), byte for byte (the call_sessions shape).
--
-- ROLLBACK: rollback.sql beside this file (forward repair is preferred). Roll the application back first: the
-- previous application never reads this table. The guard refuses while any row exists (each row is a record the
-- Privacy Policy says Swift keeps with its order).

SET lock_timeout = '10s';

-- 1. The table (Prisma-shaped).
-- CreateTable
CREATE TABLE "appointment_no_shows" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "orderId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" TEXT NOT NULL,

    CONSTRAINT "appointment_no_shows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appointment_no_shows_orderId_key" ON "appointment_no_shows"("orderId");

-- CreateIndex
CREATE INDEX "appointment_no_shows_tenantId_idx" ON "appointment_no_shows"("tenantId");

-- AddForeignKey
ALTER TABLE "appointment_no_shows" ADD CONSTRAINT "appointment_no_shows_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_no_shows" ADD CONSTRAINT "appointment_no_shows_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. The tenant wall (rlsDdlFor('appointment_no_shows')).
ALTER TABLE "appointment_no_shows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_no_shows" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "appointment_no_shows";
CREATE POLICY "tenant_isolation" ON "appointment_no_shows"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- 3. Tenant lineage (tenantLineageDdl(), the appointment_no_shows rule).
CREATE OR REPLACE FUNCTION appointment_no_shows_tenant_matches_order() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM orders WHERE id = NEW."orderId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'appointment_no_shows row % names orders row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."orderId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'appointment_no_shows row % names tenant % but its orders row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."orderId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointment_no_shows_tenant_matches_order ON appointment_no_shows;

CREATE TRIGGER appointment_no_shows_tenant_matches_order BEFORE INSERT OR UPDATE OF "tenantId", "orderId" ON appointment_no_shows FOR EACH ROW EXECUTE FUNCTION appointment_no_shows_tenant_matches_order();
