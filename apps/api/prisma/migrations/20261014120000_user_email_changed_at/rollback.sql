-- [OWNER #13 · Opus S2] Rolling this back removes the seven-day solo quiet
-- period after an email change. Roll back the code that reads the column
-- (solo-approval.ts, customer.routes.ts PUT /profile) first or together.
-- The column is a date, not a record anyone relies on afterwards; nothing
-- else references it.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "users" DROP COLUMN IF EXISTS "emailChangedAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261014120000_user_email_changed_at';
COMMIT;
