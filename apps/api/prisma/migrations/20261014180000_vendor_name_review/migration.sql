-- [GUARDRAILS §8 · owner 14 Oct 2026] Store names about banned goods are held for a person.
--
-- A store whose own words (name, description, tags) mention goods Swift never
-- carries is hidden from customers, with its items, until a person holding the
-- catalogue-approver grant approves exactly those words. These columns record
-- that approval: the fingerprint of the words approved, and when. The verdict
-- is never stored; it is read from the words on every request.
--
-- Nullable, no default: a metadata-only column add, no table rewrite. Every
-- existing store reads as "never approved", which is exactly where the rule
-- starts: a store whose words hit is held until a person checks it.
SET lock_timeout = '10s';
ALTER TABLE "vendors" ADD COLUMN "nameReviewApprovedHash" TEXT,
ADD COLUMN "nameReviewApprovedAt" TIMESTAMP(3);
