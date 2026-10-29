-- ROLLBACK for 20261029010000_pro_offerings_hours (a pro's offerings, hours and time off; one pro, one time).
--
-- Forward repair is preferred. Roll the application back first: the previous application
-- knows no offerings, hours or time off. While INSTANT_BOOKING is off nothing writes them, so
-- the new tables and columns are empty. The guard refuses when rolling back WOULD lose
-- something:
--  - a provider's service, weekly hours or time off would be erased;
--  - a job booked from a provider's menu would lose the service it was booked under and when
--    it ends (the time the provider gave it).
-- No job is cancelled, moved or released by this file. The identical-start unique of
-- 20260826000000_service_job_slot_exclusivity was never touched and stays.
BEGIN;
-- Row-level security is FORCED on service_jobs and on the new tables: without this, a role
-- that does not bypass it sees no rows, the guard passes blind, and a setting is dropped.
-- With it, such a role gets an error instead.
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "service_offerings") THEN
    RAISE EXCEPTION 'PRO_OFFERINGS_IN_USE: a provider has set up bookable services; rolling back would erase them. Not rolling back';
  END IF;
  IF EXISTS (SELECT 1 FROM "service_provider_time_off") THEN
    RAISE EXCEPTION 'PRO_TIME_OFF_IN_USE: a provider has set time off; rolling back would erase it. Not rolling back';
  END IF;
  IF EXISTS (SELECT 1 FROM "service_providers" WHERE "weeklyHours" IS NOT NULL) THEN
    RAISE EXCEPTION 'PRO_HOURS_IN_USE: a provider has set weekly hours; rolling back would erase them. Not rolling back';
  END IF;
  IF EXISTS (SELECT 1 FROM "service_jobs" WHERE "endsAt" IS NOT NULL OR "offeringId" IS NOT NULL) THEN
    RAISE EXCEPTION 'PRO_BOOKED_JOBS_EXIST: a job was booked from a provider menu; rolling back would erase its service and its end. Not rolling back';
  END IF;
END $guard$;
DROP TRIGGER service_provider_time_off_tenant_matches_provider ON "service_provider_time_off";
DROP FUNCTION service_provider_time_off_tenant_matches_provider();
DROP TRIGGER service_offerings_tenant_matches_provider ON "service_offerings";
DROP FUNCTION service_offerings_tenant_matches_provider();
DROP TRIGGER service_jobs_offering_matches_provider ON "service_jobs";
DROP FUNCTION service_jobs_offering_matches_provider();
ALTER TABLE "service_jobs" DROP CONSTRAINT "service_jobs_provider_one_at_a_time";
ALTER TABLE "service_jobs" DROP CONSTRAINT "service_jobs_ends_after_start";
ALTER TABLE "service_jobs" DROP CONSTRAINT "service_jobs_offeringId_fkey";
DROP INDEX "service_jobs_offeringId_idx";
ALTER TABLE "service_jobs" DROP COLUMN "endsAt", DROP COLUMN "offeringId";
ALTER TABLE "service_providers" DROP COLUMN "weeklyHours";
-- Each table goes with its own checks, keys, indexes and tenant policy.
DROP TABLE "service_provider_time_off";
DROP TABLE "service_offerings";
-- btree_gist stays installed: an extension is shared database state (bookings use it too).
DO $ledger$
DECLARE n integer;
BEGIN
  -- The applied row only: a failed attempt that was marked rolled back (prisma migrate resolve) stays as history.
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029010000_pro_offerings_hours' AND "rolled_back_at" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
