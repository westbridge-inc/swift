-- [OWNER #13 · 13 Oct 2026] SOLO MODE for two-person approvals.
--
-- The owner is the only admin. A money (C4) or platform (C5) action takes two
-- people, so none could ever happen. Solo mode lets the requester approve
-- their OWN request, only as the owner, only while they are the one admin who
-- could approve it, only after a cancellable wait, with a fresh sign-in code,
-- an audit row and an email at each step (solo-approval.ts).
--
-- Three columns record it. A requester can approve their own request ONLY
-- through solo mode, and the database says so: approvedBy may equal
-- requestedBy only when decidedSolo is set, and decidedSolo needs the wait to
-- have been recorded. NOT VALID: the checks bind every new or changed row;
-- rows written before this migration were never self-approved (the decision
-- route always refused it) and are not re-read under a lock at deploy time.
--
-- CANCELLED (the requester withdrew the request) is a new value of the
-- free-text status column; nothing here constrains that column's values.
SET lock_timeout = '10s';
ALTER TABLE "privileged_approvals"
  ADD COLUMN "soloRequestedAt" TIMESTAMP(3),
  ADD COLUMN "soloEligibleAt" TIMESTAMP(3),
  ADD COLUMN "decidedSolo" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "privileged_approvals"
  ADD CONSTRAINT "privileged_approvals_self_approval_solo_only"
    CHECK ("approvedBy" IS NULL OR "approvedBy" <> "requestedBy" OR "decidedSolo") NOT VALID,
  ADD CONSTRAINT "privileged_approvals_solo_needs_wait"
    CHECK (NOT "decidedSolo" OR ("soloRequestedAt" IS NOT NULL AND "soloEligibleAt" IS NOT NULL AND "soloEligibleAt" >= "soloRequestedAt")) NOT VALID;
