-- [OWNER #13 · Opus money review S2, 14 Oct 2026] When an account's email last
-- changed.
--
-- Solo approval (20261013200000_approval_solo_mode) warns the owner at the
-- account's email, at the request and at the decision. A stolen session must
-- never be able to point that address elsewhere and then go solo, so:
-- solo approval stays off for seven days after any email change
-- (admin-email-change.ts), and an admin's email change takes a fresh sign-in
-- code and tells the old address (customer.routes.ts PUT /profile).
--
-- Nullable, no default: a metadata-only column add, no table rewrite. Null
-- means the email has not changed since this was recorded.
SET lock_timeout = '10s';
ALTER TABLE "users" ADD COLUMN "emailChangedAt" TIMESTAMP(3);
