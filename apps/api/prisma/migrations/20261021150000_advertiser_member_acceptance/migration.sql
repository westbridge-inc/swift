-- [ads security · SWITCHES fact-check, 21 Oct] An advertiser team grows by invitation and acceptance.
-- A member row with "acceptedAt" NULL is an open invitation: it opens nothing and is never named on
-- the team list. No default (fail closed): a row written without an acceptance is an invitation; the
-- OWNER row made at registration sets it explicitly.
ALTER TABLE "advertiser_members" ADD COLUMN "acceptedAt" TIMESTAMP(3);
-- An OWNER registered the company: accepted when the row was made. Every other existing member was
-- added by phone and never asked: it stays NULL, an open invitation from now on.
UPDATE "advertiser_members" SET "acceptedAt" = "createdAt" WHERE "role" = 'OWNER';
