-- [S0] A SERVICE PROVIDER COULD BE DOUBLE-BOOKED.
--
-- POST /jobs/:id/schedule wrote the customer's chosen slot with a bare UPDATE:
-- no conflict query, no compare-and-swap, and not one unique constraint on
-- "service_jobs" (the phase9 migration created only "service_providers_userId_key"
-- plus three plain indexes). Two customers could hold the same electrician for
-- Tuesday 09:00 and both be told it was booked. One of them was going to be
-- stood up. The founder's rule is the opposite: "if that time doesn't work it's
-- booked… the dashboard for the service vendor sees if they can go."
--
-- WHAT IS UNIQUE, AND WHY THIS SHAPE
-- The key is ("providerId", "scheduledFor") over LIVE jobs only — a job that is
-- actually going to happen. Deliberately part of the key:
--   * SCHEDULED    — the customer holds the slot while the provider accepts or
--                    declines it (§4.3). It must block from the moment it is
--                    taken, not from confirmation, or the same hour gets
--                    offered to five customers and four get stood up.
--   * IN_PROGRESS  — the provider is on the job.
-- Deliberately NOT part of the key:
--   * COMPLETED / CANCELLED — history, not a commitment. If a closed job kept
--                    holding its slot, cancelling could never free a Tuesday
--                    morning again and the provider's calendar would silt up
--                    permanently. Releasing by STATUS (never by deleting a row)
--                    keeps the audit trail whole — Swift deletes nothing.
--   * REQUESTED / QUOTED — no time is agreed yet, and /jobs/:id/decline-slot
--                    returns a job to QUOTED with "scheduledFor" NULL, which
--                    has to release the slot the instant it happens.
--   * "scheduledFor" IS NULL — nothing is being held. (NULLs are distinct in a
--                    unique index anyway; saying it in the predicate states the
--                    intent and keeps the index to live rows only.)
--
-- This is the same shape the appointment side has relied on since step6
-- ("bookings_item_slot_live_key"): one live holder per slot, released by
-- status. Prisma cannot express a partial unique, so it lives in SQL.
--
-- KNOWN LIMIT, STATED OUT LOUD: a ServiceJob has a start time and no duration,
-- so this key can only collide on an IDENTICAL start. A 09:00 three-hour job
-- and a 10:00 job are still bookable together. Closing that needs a duration on
-- the job (a schema/product change, not this migration) — reported, not faked.
SET lock_timeout = '10s';

-- EXISTING DATA FIRST — this must not explode on a live customer's calendar.
-- If the table already contains a double-book, CREATE UNIQUE INDEX would abort
-- the whole deploy and leave the defect in place. Documented resolution:
--   winner  = the strongest claim on the slot: a provider-CONFIRMED job beats
--             an unconfirmed one (the provider actually said yes to that one),
--             then the earliest confirmation, then the earliest created, then
--             the id — deterministic, replayable, and the same first-come rule
--             the route now enforces.
--   loser   = returned to QUOTED with the slot cleared. That is EXACTLY the
--             state /jobs/:id/decline-slot produces, which every client already
--             renders as "pick another time" — a state the product knows, not
--             an invented one. No row is deleted, no quote amount is touched.
-- Every released job is printed with its id, provider and slot so operators can
-- call those customers: a migration cannot send a notification, and pretending
-- the customer was told would be the exact lie this whole change exists to stop.
DO $$
DECLARE
  loser    RECORD;
  released INTEGER := 0;
BEGIN
  FOR loser IN
    SELECT ranked."id", ranked."providerId", ranked."scheduledFor", ranked."status"::text AS status_text
      FROM (
        SELECT j."id", j."providerId", j."scheduledFor", j."status",
               row_number() OVER (
                 PARTITION BY j."providerId", j."scheduledFor"
                 ORDER BY (j."providerConfirmedAt" IS NULL) ASC,
                          j."providerConfirmedAt" ASC,
                          j."createdAt" ASC,
                          j."id" ASC
               ) AS rn
          FROM "service_jobs" j
         WHERE j."scheduledFor" IS NOT NULL
           AND j."status" IN ('SCHEDULED', 'IN_PROGRESS')
      ) ranked
     WHERE ranked.rn > 1
  LOOP
    UPDATE "service_jobs"
       SET "status" = 'QUOTED',
           "scheduledFor" = NULL,
           "providerConfirmedAt" = NULL
     WHERE "id" = loser."id";
    released := released + 1;
    RAISE WARNING 'double-booked service job released: job=% provider=% slot=% was=% -> QUOTED with no slot. This customer must be contacted to re-book.',
      loser."id", loser."providerId", loser."scheduledFor", loser.status_text;
  END LOOP;

  IF released > 0 THEN
    RAISE WARNING '% pre-existing double-booked service job(s) were returned to QUOTED so the provider is committed to one customer per slot. Ids are in the warnings above.', released;
  END IF;
END
$$;

-- The judge. IF NOT EXISTS because the db-push path (CI/dev/test databases have
-- no _prisma_migrations table) creates this same object idempotently, and a
-- migration that aborts on an already-correct database helps nobody.
CREATE UNIQUE INDEX IF NOT EXISTS "service_jobs_provider_slot_live_key"
    ON "service_jobs" ("providerId", "scheduledFor")
 WHERE "scheduledFor" IS NOT NULL
   AND "status" IN ('SCHEDULED'::"ServiceJobStatus", 'IN_PROGRESS'::"ServiceJobStatus");

-- IF NOT EXISTS is silent when a DIFFERENT index already owns the name, which
-- would leave the deploy green and the double-book alive. Fail loudly instead.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename  = 'service_jobs'
       AND indexname  = 'service_jobs_provider_slot_live_key'
       AND indexdef LIKE '%UNIQUE%'
       AND indexdef LIKE '%providerId%'
       AND indexdef LIKE '%scheduledFor%'
       AND indexdef LIKE '%WHERE%'
  ) THEN
    RAISE EXCEPTION 'service_jobs_provider_slot_live_key is missing or does not guard (providerId, scheduledFor) on live jobs — a provider can still be double-booked';
  END IF;
END
$$;
