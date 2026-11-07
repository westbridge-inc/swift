-- [ROLE-DOCS · owner ruling 21 Oct 2026 ~16:05Z] Stored copies of the documents Swift no longer asks for.
-- The code stops asking for them in the same change; this decides what happens to copies already held,
-- under the retention rules (R24 · research C4: keep a document only while it is needed):
--
--  1. A delivery rider's police clearance (riders are no longer offered one; taxi drivers keep it):
--     deleted at the next daily retention sweep (retention clock = now). Criminal-record data
--     (DPA 2023 s.2) that no rule of Swift's needs any more. A person who also holds a taxi Driver
--     profile keeps theirs.
--  2. A vehicle partner's national ID (a driver's licence is their photo ID; the optional ID is gone):
--     deleted at the next daily sweep. A bicycle rider REQUIRES the national ID and keeps it. An account
--     with no rider or driver profile is left alone (its vehicle cannot be told yet).
--  3. Liquor licences, pharmacy authorisations and NIS employer registrations (no gate or list names them;
--     alcohol and medicines are banned outright): the business-document window, deleted 90 days from now.
--  4. GEI_LICENCE service qualifications (the same licence the electrician's checklist already requires;
--     never verified by anyone — no review route exists): deleted now. They hold only a typed number.
--
-- Data only, forward only, idempotent: a clock is only ever SET or brought FORWARD, never extended; a purged
-- document, a document under a legal hold, or a customer's own documents (role CUSTOMER, which is also where
-- a marketplace service provider's police clearance lives) are never touched. The daily reaper
-- (purgeExpiredDocuments) does the deleting, with its shred, probe and deletion receipt, and re-checks the
-- legal hold at its final step. No rollback.sql: a cleared clock cannot be restored, and a deleted document
-- is uploaded again if it is ever needed.
SET lock_timeout = '10s';

UPDATE verification_documents AS d
SET "retentionExpiresAt" = now()
WHERE d."docType" = 'police_clearance'
  AND d.role IN ('MOVER', 'RIDER', 'DRIVER')
  AND d."purgedAt" IS NULL
  AND d."legalHoldId" IS NULL
  AND (d."retentionExpiresAt" IS NULL OR d."retentionExpiresAt" > now())
  AND EXISTS (SELECT 1 FROM riders AS r WHERE r."userId" = d."userId")
  AND NOT EXISTS (SELECT 1 FROM drivers AS v WHERE v."userId" = d."userId");

UPDATE verification_documents AS d
SET "retentionExpiresAt" = now()
WHERE d."docType" = 'national_id'
  AND d.role IN ('MOVER', 'RIDER', 'DRIVER')
  AND d."purgedAt" IS NULL
  AND d."legalHoldId" IS NULL
  AND (d."retentionExpiresAt" IS NULL OR d."retentionExpiresAt" > now())
  AND (EXISTS (SELECT 1 FROM riders AS r WHERE r."userId" = d."userId")
       OR EXISTS (SELECT 1 FROM drivers AS v WHERE v."userId" = d."userId"))
  AND NOT EXISTS (SELECT 1 FROM riders AS r WHERE r."userId" = d."userId" AND r."vehicleType" = 'BICYCLE');

UPDATE verification_documents AS d
SET "retentionExpiresAt" = now() + interval '90 days'
WHERE d."docType" IN ('liquor_licence', 'pharmacy_authorisation', 'nis_employer_reg')
  AND d."purgedAt" IS NULL
  AND d."legalHoldId" IS NULL
  AND (d."retentionExpiresAt" IS NULL OR d."retentionExpiresAt" > now() + interval '90 days');

DELETE FROM service_qualifications WHERE type = 'GEI_LICENCE';
