import type { BusyInterval } from '../booking/availability';

// ---------------------------------------------------------------------------
// [BOOK-P1 Track P] ONE PRO, ONE TIME — the database's half.
//
// A pro has one body. Until now the only guard was the partial unique on
// ("providerId", "scheduledFor") for live jobs (service_job_slot_exclusivity),
// which collides only on an IDENTICAL instant: a 09:00 three-hour job and a
// 10:00 job were bookable together, and 09:00:00 vs 09:00:01 slipped through.
//
// A live job (SCHEDULED or IN_PROGRESS, with a time) now holds the provider
// from "scheduledFor" to "endsAt": [start, end), back to back is not an
// overlap. A job booked from the provider's menu (P2) carries its end. A quote
// job has no end and holds its MINIMUM BLOCK: the one minute it starts in
// (QUOTE_JOB_MIN_BLOCK_MINUTES), exactly the time today's quote flow already
// reserves (the same minute can never be taken twice, a different minute
// can), so nothing changes for the quote flow that builds 9, 11 and 12 run.
//
//   service_jobs_provider_one_at_a_time   EXCLUDE USING gist ("providerId" WITH =,
//                                          <the held range> WITH &&) for live jobs.
//   service_jobs_ends_after_start         an end is after its start, and needs one.
//   service_jobs_offering_matches_provider a booked service is the provider's own.
//   service_offerings_duration_check      a service lasts 5 to 600 minutes.
//   service_offerings_price_check         a service has a price above zero.
//   service_provider_time_off_window_check a window of time off ends after it starts.
//
// The slot columns are timestamp(3) holding UTC instants, so the range is a
// tsrange (as bookings, booking/one-at-a-time.ts). The held range is written
// ONCE here (SERVICE_JOB_RANGE_SQL) and the application's twin is
// serviceJobInterval(): the provider's calendar (provider-calendar.ts)
// subtracts exactly what the database refuses.
//
// Every statement is idempotent. Migration 20261029010000_pro_offerings_hours
// carries this text byte for byte (pro-offerings-migration.test.ts), and the
// test installer heals a db-push database with the same statements.
// ---------------------------------------------------------------------------

export const SERVICE_JOB_EXCLUSION = 'service_jobs_provider_one_at_a_time';
export const SERVICE_JOB_END_CHECK = 'service_jobs_ends_after_start';
export const SERVICE_JOB_OFFERING_TRIGGER = 'service_jobs_offering_matches_provider';
export const OFFERING_DURATION_CHECK = 'service_offerings_duration_check';
export const OFFERING_PRICE_CHECK = 'service_offerings_price_check';
export const TIME_OFF_WINDOW_CHECK = 'service_provider_time_off_window_check';

/** The time a quote job (no end) holds: the minute it starts in. */
export const QUOTE_JOB_MIN_BLOCK_MINUTES = 1;
/** The shortest and longest bookable service, the bounds of a listing's duration too. */
export const MIN_OFFERING_MINUTES = 5;
export const MAX_OFFERING_MINUTES = 600;

/** The job states that hold the provider's time. */
export const LIVE_SERVICE_JOB_STATUSES = ['SCHEDULED', 'IN_PROGRESS'] as const;

/** THE held range of a live job, in SQL. */
export const SERVICE_JOB_RANGE_SQL = `tsrange("scheduledFor", COALESCE("endsAt", "scheduledFor" + interval '${QUOTE_JOB_MIN_BLOCK_MINUTES} minute'))`;

/** THE held range of a live job, in the application: [scheduledFor, endsAt), or the minimum block. */
export function serviceJobInterval(job: { scheduledFor: Date; endsAt: Date | null }): BusyInterval {
  return {
    start: job.scheduledFor,
    end: job.endsAt ?? new Date(job.scheduledFor.getTime() + QUOTE_JOB_MIN_BLOCK_MINUTES * 60_000),
  };
}

export function providerTimeDdl(): string[] {
  return [
    `CREATE EXTENSION IF NOT EXISTS btree_gist`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${SERVICE_JOB_END_CHECK}') THEN
        ALTER TABLE "service_jobs" ADD CONSTRAINT "${SERVICE_JOB_END_CHECK}" CHECK ("endsAt" IS NULL OR ("scheduledFor" IS NOT NULL AND "endsAt" > "scheduledFor"));
      END IF;
    END $$`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${SERVICE_JOB_EXCLUSION}') THEN
        ALTER TABLE "service_jobs" ADD CONSTRAINT "${SERVICE_JOB_EXCLUSION}"
          EXCLUDE USING gist ("providerId" WITH =, ${SERVICE_JOB_RANGE_SQL} WITH &&)
          WHERE ("scheduledFor" IS NOT NULL AND "status" IN ('SCHEDULED', 'IN_PROGRESS'));
      END IF;
    END $$`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${OFFERING_DURATION_CHECK}') THEN
        ALTER TABLE "service_offerings" ADD CONSTRAINT "${OFFERING_DURATION_CHECK}" CHECK ("durationMinutes" BETWEEN ${MIN_OFFERING_MINUTES} AND ${MAX_OFFERING_MINUTES});
      END IF;
    END $$`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${OFFERING_PRICE_CHECK}') THEN
        ALTER TABLE "service_offerings" ADD CONSTRAINT "${OFFERING_PRICE_CHECK}" CHECK ("price" > 0);
      END IF;
    END $$`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${TIME_OFF_WINDOW_CHECK}') THEN
        ALTER TABLE "service_provider_time_off" ADD CONSTRAINT "${TIME_OFF_WINDOW_CHECK}" CHECK (("start" IS NULL AND "end" IS NULL) OR ("start" IS NOT NULL AND "end" IS NOT NULL AND "start" < "end"));
      END IF;
    END $$`,
    `CREATE OR REPLACE FUNCTION ${SERVICE_JOB_OFFERING_TRIGGER}() RETURNS trigger AS $$
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
      END $$ LANGUAGE plpgsql`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${SERVICE_JOB_OFFERING_TRIGGER}' AND tgrelid = 'service_jobs'::regclass) THEN
        CREATE TRIGGER ${SERVICE_JOB_OFFERING_TRIGGER} BEFORE INSERT OR UPDATE OF "offeringId", "providerId" ON service_jobs FOR EACH ROW EXECUTE FUNCTION ${SERVICE_JOB_OFFERING_TRIGGER}();
      END IF;
    END $$`,
  ];
}

/** Did a write lose to the one-pro-one-time exclusion (SQLSTATE 23P01)? Read from the
 *  driver's code or the constraint's name, as booking/one-at-a-time.ts does. */
export function isServiceJobExclusionViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; meta?: { code?: unknown } | null; message?: unknown };
  if (e.code === '23P01' || e.meta?.code === '23P01') return true;
  return typeof e.message === 'string' && (e.message.includes(SERVICE_JOB_EXCLUSION) || /\b23P01\b/.test(e.message));
}
