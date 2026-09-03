-- [A-18] A support ticket closes with a structured disposition, not just a note.
-- SAFETY tickets accept only ACTION_TAKEN, ESCALATED_SAFETY or NO_RISK_FOUND —
-- enforced in the service, recorded here so a safety review can read it back.
CREATE TYPE "SupportResolution" AS ENUM ('ANSWERED', 'ACTION_TAKEN', 'ESCALATED_SAFETY', 'NO_RISK_FOUND', 'UNABLE_TO_CONTACT');

ALTER TABLE "support_tickets" ADD COLUMN "resolution" "SupportResolution";
