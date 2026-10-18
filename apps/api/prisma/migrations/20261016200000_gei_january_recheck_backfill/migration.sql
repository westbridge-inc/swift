-- [R15/R16 · coordinator ruling 16 Oct 2026, delegated by the owner] A GEI electrical licence approved
-- before the January re-check rule was approved with no expiry (the licence was not on the expiring
-- list), so it would never be checked again. Every such approval now lapses at the COMING January
-- re-check: 16 January, 00:00 Guyana time, of the year after the current Guyana year — the same instant
-- verification.service januaryRecheckCap() gives a new approval. Its holder is reminded from 1 December.
--
-- Data only, and forward only:
--  * Touches ONLY approved gei_electrical_licence rows whose expiry is missing or later than the coming
--    re-check. An earlier expiry is kept (brought forward, never extended). Nothing else is read or changed.
--  * Idempotent: once a row carries the re-check it no longer matches, so a second run changes nothing.
--  * Production holds no GEI approval (no service provider has been approved there), so it changes no row.
--  * The database's own triggers follow the new expiry: renewal_schedule (the reminders and the
--    suspension date) and document_record (the durable record's expiresOn).
--  * A row whose account already holds ANOTHER committed GEI approval for the same subject is left for a
--    person: re-committing one of them would make the record trigger supersede the other.
-- No rollback.sql: the earlier value of a changed row was "no expiry" (or a later date) and is not kept;
-- an approval that should last longer is re-approved by a reviewer with the year printed on the licence.
SET lock_timeout = '10s';

WITH recheck AS (
  SELECT make_timestamptz(
           EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Guyana'))::int + 1, 1, 16, 0, 0, 0, 'America/Guyana'
         ) AT TIME ZONE 'UTC' AS at
)
UPDATE verification_documents AS d
SET "expiresAt" = recheck.at
FROM recheck
WHERE d."docType" = 'gei_electrical_licence'
  AND d.status = 'APPROVED'
  AND (d."expiresAt" IS NULL OR d."expiresAt" > recheck.at)
  AND NOT EXISTS (
    SELECT 1 FROM verification_documents AS other
    WHERE other."userId" = d."userId"
      AND other."docType" = d."docType"
      AND other.id <> d.id
      AND other."subjectId" IS NOT DISTINCT FROM d."subjectId"
      AND other.state = 'COMMITTED'
  );
