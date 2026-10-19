-- [Row 231 · FABLE-AUTH-1 / DS108] Session credentials at rest are SHA-256 digests.
--
-- sessions.token / refreshToken / previousRefreshToken held the bearer access
-- token and both refresh tokens in plaintext: a database read — a backup, a
-- replica, an injection, an operator's psql — was a login for a week. From
-- here on the columns hold only the lowercase-hex SHA-256 digest of the
-- credential the client holds. The API digests every write and every lookup
-- (src/lib/session-credential.ts: the prisma `sessionCredentialDigest`
-- extension; raw SQL compares digests explicitly), so the clients' plaintext
-- keeps working unchanged.
--
-- Expand-in-place rather than a new column: the field names are the ORM
-- contract of ~280 call sites, and a digest column with a dead plaintext
-- twin would leave a plaintext-shaped slot for a future write to fill. The
-- three CHECK constraints below are the contract instead — a plaintext
-- credential cannot be stored from ANY path, raw SQL, seeds and scripts
-- included — and there is no dead column to contract later.
--
-- Rows are digested first (a replayed run leaves an already-digested row
-- alone; a NULL previous credential stays NULL), then the shape is enforced.
-- Sessions are ephemeral (7 days) and carry no money, so the table is small
-- and the rewrite short; lock_timeout bounds the wait for the table lock.
--
-- HASHED IN PLACE, not invalidated: every live session (a store reviewer on
-- staging, a driver mid-shift, a partner at the till) keeps working — the
-- client still presents the same plaintext, and the API now looks it up by
-- its digest. A forced sign-in buys nothing here: the old plaintext stops
-- being stored the moment this runs, which is the exposure that mattered.
--
-- Rollback note: a one-way hash has no inverse. Code from before this
-- migration compares plaintext and cannot match a digested row, so rolling
-- the API back means: DROP the three constraints, DELETE FROM "sessions"
-- (every client signs in again — the same outcome as a log-out-everywhere).
-- Nothing else references the credential columns.
SET lock_timeout = '10s';

UPDATE "sessions"
   SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex'),
       "refreshToken" = encode(sha256(convert_to("refreshToken", 'UTF8')), 'hex'),
       "previousRefreshToken" = CASE WHEN "previousRefreshToken" IS NULL THEN NULL
                                     ELSE encode(sha256(convert_to("previousRefreshToken", 'UTF8')), 'hex') END
 WHERE "token" !~ '^[0-9a-f]{64}$';

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_token_digest_check" CHECK ("token" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "sessions_refreshToken_digest_check" CHECK ("refreshToken" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "sessions_previousRefreshToken_digest_check" CHECK ("previousRefreshToken" IS NULL OR "previousRefreshToken" ~ '^[0-9a-f]{64}$');
