-- ROLLBACK for 20261018190000_session_credential_digests (session credentials at rest are digests).
--
-- A one-way digest has no inverse: code from before this migration compares the plaintext a
-- client presents with the stored value and can never match a digested row. So rolling back is
-- a sign-out-everywhere: stop the API and worker, run this, then start the previous application.
-- Every device signs in again (the same outcome as a log-out-everywhere). The constraints go
-- first because the previous application writes plaintext. Nothing else references the
-- credential columns.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "sessions"
  DROP CONSTRAINT IF EXISTS "sessions_token_digest_check",
  DROP CONSTRAINT IF EXISTS "sessions_refreshToken_digest_check",
  DROP CONSTRAINT IF EXISTS "sessions_previousRefreshToken_digest_check";
DELETE FROM "sessions";
DO $ledger$ DECLARE n integer; BEGIN
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261018190000_session_credential_digests';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
END $ledger$;
COMMIT;
