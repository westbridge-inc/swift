-- Rollback of 20261021150000_advertiser_member_acceptance. Open invitations become memberships
-- again (the old behaviour), so drop them first if that must not happen:
--   DELETE FROM "advertiser_members" WHERE "acceptedAt" IS NULL;
BEGIN;
ALTER TABLE "advertiser_members" DROP COLUMN IF EXISTS "acceptedAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261021150000_advertiser_member_acceptance';
COMMIT;
