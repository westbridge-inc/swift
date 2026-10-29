-- [BOOK-P1 Track P "Offerings and hours"] A pro's bookable services, weekly hours and time off,
-- and ONE PRO, ONE TIME over the time each live job holds.
--
-- Until now the only guard on a pro's calendar was the partial unique on ("providerId",
-- "scheduledFor") for live jobs: it collides only on an identical instant, so a 09:00
-- three-hour job and a 10:00 job were bookable together, and 09:00:00 vs 09:00:01 slipped through.
--
-- FORWARD
--  0. PRE-FLIGHT, read-only. If two live jobs (SCHEDULED or IN_PROGRESS) of one provider already
--     overlap under the new rule (every existing job is a quote job: it holds the minute it starts
--     in), the migration stops with the list of job ids and changes NOTHING. It never cancels,
--     moves or releases a job (unlike 20260826000000_service_job_slot_exclusivity): a person
--     settles each pair with the provider and the customers, then the deploy runs again.
--     Row security is switched off for its read only, so it sees every row or fails; it never
--     passes blind. DEPLOY ROLE: service_jobs has FORCED row security, so the login that runs
--     `prisma migrate deploy` must be able to read past it (the table owner with BYPASSRLS, or
--     a superuser, as every earlier migration that reads a walled table needs). A login that
--     cannot gets an error at this step and the migration stops with nothing changed.
--  1. service_jobs."offeringId" (the booked service; null = a quote job) and "endsAt" (when the
--     provider's time on it ends; null = the minimum block); service_providers."weeklyHours";
--     the service_offerings and service_provider_time_off tables (Prisma-shaped, empty).
--  2. The provider's time, held by the database (src/modules/services/provider-time.ts
--     providerTimeDdl(), byte for byte): btree_gist; an end is after its start; the
--     one-pro-one-time exclusion over ("providerId", the held range) for live jobs; a service
--     lasts 5 to 600 minutes and costs more than zero; a window of time off ends after it starts;
--     a booked service is the provider's own. The identical-start unique stays (an identical
--     start is an overlap too).
--  3. The tenant wall on both new tables: RLS ENABLED and FORCED with the canonical policy
--     (rlsDdlFor(), byte for byte).
--  4. Tenant lineage: a service and a time off inherit the tenant of the person the provider
--     profile belongs to (tenantLineageDdl(), byte for byte).
--
-- ROLLBACK: rollback.sql beside this file (forward repair is preferred). Roll the application
-- back first.

SET lock_timeout = '10s';

-- 0. Pre-flight: refuse loudly, release nothing.
DO $preflight$
DECLARE
  pair_count integer;
  pair_ids text;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  WITH live AS (
    SELECT j.id, j."providerId", j."scheduledFor" AS s, j."scheduledFor" + interval '1 minute' AS e
      FROM "service_jobs" j
     WHERE j."scheduledFor" IS NOT NULL AND j."status" IN ('SCHEDULED', 'IN_PROGRESS')
  )
  SELECT count(*), string_agg(a.id || ' & ' || c.id, ', ' ORDER BY a.s, a.id, c.id)
    INTO pair_count, pair_ids
    FROM live a JOIN live c
      ON c."providerId" = a."providerId" AND a.id < c.id
     AND a.s < c.e AND c.s < a.e;
  IF pair_count > 0 THEN
    RAISE EXCEPTION 'SERVICE_JOB_OVERLAPS_EXIST: % pair(s) of live jobs of one provider overlap; nothing was changed and no job was released. Settle each pair with the provider and the customers (cancel or move one), then deploy again. Pairs: %', pair_count, pair_ids;
  END IF;
END $preflight$;

-- 1. The columns and tables (Prisma-shaped).
-- AlterTable
ALTER TABLE "service_jobs" ADD COLUMN     "endsAt" TIMESTAMP(3),
ADD COLUMN     "offeringId" TEXT;

-- AlterTable
ALTER TABLE "service_providers" ADD COLUMN     "weeklyHours" JSONB;

-- CreateTable
CREATE TABLE "service_offerings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_provider_time_off" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "providerId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "start" TEXT,
    "end" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_provider_time_off_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_offerings_providerId_idx" ON "service_offerings"("providerId");

-- CreateIndex
CREATE INDEX "service_offerings_tenantId_idx" ON "service_offerings"("tenantId");

-- CreateIndex
CREATE INDEX "service_provider_time_off_providerId_date_idx" ON "service_provider_time_off"("providerId", "date");

-- CreateIndex
CREATE INDEX "service_provider_time_off_tenantId_idx" ON "service_provider_time_off"("tenantId");

-- CreateIndex
CREATE INDEX "service_jobs_offeringId_idx" ON "service_jobs"("offeringId");

-- AddForeignKey
ALTER TABLE "service_offerings" ADD CONSTRAINT "service_offerings_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "service_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_provider_time_off" ADD CONSTRAINT "service_provider_time_off_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "service_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "service_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 2. The provider's time, held by the database (providerTimeDdl()).
CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_jobs_ends_after_start') THEN
        ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_ends_after_start" CHECK ("endsAt" IS NULL OR ("scheduledFor" IS NOT NULL AND "endsAt" > "scheduledFor"));
      END IF;
    END $$;
DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_jobs_provider_one_at_a_time') THEN
        ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_provider_one_at_a_time"
          EXCLUDE USING gist ("providerId" WITH =, tsrange("scheduledFor", COALESCE("endsAt", "scheduledFor" + interval '1 minute')) WITH &&)
          WHERE ("scheduledFor" IS NOT NULL AND "status" IN ('SCHEDULED', 'IN_PROGRESS'));
      END IF;
    END $$;
DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_offerings_duration_check') THEN
        ALTER TABLE "service_offerings" ADD CONSTRAINT "service_offerings_duration_check" CHECK ("durationMinutes" BETWEEN 5 AND 600);
      END IF;
    END $$;
DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_offerings_price_check') THEN
        ALTER TABLE "service_offerings" ADD CONSTRAINT "service_offerings_price_check" CHECK ("price" > 0);
      END IF;
    END $$;
DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_provider_time_off_window_check') THEN
        ALTER TABLE "service_provider_time_off" ADD CONSTRAINT "service_provider_time_off_window_check" CHECK (("start" IS NULL AND "end" IS NULL) OR ("start" IS NOT NULL AND "end" IS NOT NULL AND "start" < "end"));
      END IF;
    END $$;
CREATE OR REPLACE FUNCTION service_jobs_offering_matches_provider() RETURNS trigger AS $$
      DECLARE offering_provider TEXT;
      BEGIN
        IF NEW."offeringId" IS NULL THEN RETURN NEW; END IF;
        SELECT "providerId" FROM service_offerings WHERE id = NEW."offeringId" INTO offering_provider;
        IF offering_provider IS NULL THEN
          RAISE EXCEPTION 'service_jobs row % names service_offerings row %, which does not exist or is not visible from this tenant [BOOK-P1]',
            NEW.id, NEW."offeringId" USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."providerId" IS DISTINCT FROM offering_provider THEN
          RAISE EXCEPTION 'service_jobs row % names provider % but its service % belongs to provider % [BOOK-P1]',
            NEW.id, NEW."providerId", NEW."offeringId", offering_provider USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'service_jobs_offering_matches_provider' AND tgrelid = 'service_jobs'::regclass) THEN
        CREATE TRIGGER service_jobs_offering_matches_provider BEFORE INSERT OR UPDATE OF "offeringId", "providerId" ON service_jobs FOR EACH ROW EXECUTE FUNCTION service_jobs_offering_matches_provider();
      END IF;
    END $$;

-- 3. The tenant wall (rlsDdlFor('service_offerings'), rlsDdlFor('service_provider_time_off')).
ALTER TABLE "service_offerings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_offerings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "service_offerings";
CREATE POLICY "tenant_isolation" ON "service_offerings"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "service_provider_time_off" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_provider_time_off" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "service_provider_time_off";
CREATE POLICY "tenant_isolation" ON "service_provider_time_off"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- 4. Tenant lineage (tenantLineageDdl(), the service_offerings and service_provider_time_off rules).
CREATE OR REPLACE FUNCTION service_offerings_tenant_matches_provider() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT u."tenantId" FROM users u JOIN service_providers p ON p."userId" = u.id WHERE p.id = NEW."providerId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'service_offerings row % names service_providers row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."providerId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'service_offerings row % names tenant % but its service_providers row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."providerId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS service_offerings_tenant_matches_provider ON service_offerings;
CREATE TRIGGER service_offerings_tenant_matches_provider BEFORE INSERT OR UPDATE OF "tenantId", "providerId" ON service_offerings FOR EACH ROW EXECUTE FUNCTION service_offerings_tenant_matches_provider();
CREATE OR REPLACE FUNCTION service_provider_time_off_tenant_matches_provider() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT u."tenantId" FROM users u JOIN service_providers p ON p."userId" = u.id WHERE p.id = NEW."providerId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'service_provider_time_off row % names service_providers row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."providerId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'service_provider_time_off row % names tenant % but its service_providers row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."providerId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS service_provider_time_off_tenant_matches_provider ON service_provider_time_off;
CREATE TRIGGER service_provider_time_off_tenant_matches_provider BEFORE INSERT OR UPDATE OF "tenantId", "providerId" ON service_provider_time_off FOR EACH ROW EXECUTE FUNCTION service_provider_time_off_tenant_matches_provider();
