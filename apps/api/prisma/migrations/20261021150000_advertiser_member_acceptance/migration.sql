-- [ads security · SWITCHES fact-check, 21 Oct] An advertiser team grows by invitation and acceptance.
-- A member row with "acceptedAt" NULL is an open invitation: it opens nothing and is never named on
-- the team list. New rows default to accepted (the OWNER row made at registration); an invitation is
-- written with NULL explicitly.
ALTER TABLE "advertiser_members" ADD COLUMN "acceptedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
-- An OWNER registered the company: accepted when the row was made.
UPDATE "advertiser_members" SET "acceptedAt" = "createdAt" WHERE "role" = 'OWNER';
-- Every other existing member was added by phone, never asked: an open invitation from now on.
UPDATE "advertiser_members" SET "acceptedAt" = NULL WHERE "role" <> 'OWNER';
