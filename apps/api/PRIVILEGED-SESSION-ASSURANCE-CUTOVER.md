# Privileged session assurance cutover

This is a required, non-rolling authentication-authority cutover. A session may
carry `ADMIN` or `SUPER_ADMIN` authority only when its durable `authMethod` is
`OTP`. `PASSWORD` and pre-migration `LEGACY` sessions remain valid for ordinary
accounts but fail closed if the live user row is privileged.

## Required production sequence

1. Enter the documented maintenance window and drain every old API, worker, and
   Socket.IO binary. Old binaries do not write or enforce `authMethod` and must
   not overlap the authority cutover.
2. Apply `20260808024000_session_auth_assurance` and verify the column is
   `NOT NULL`, its default is `LEGACY`, and all three enum values exist.
3. Deploy the new API and socket authority gates while privileged interfaces
   remain unavailable externally.
4. Revoke every live privileged session whose method is not `OTP` through the
   canonical mover-session revocation path. From `apps/api`, with `DATABASE_URL`
   and `REDIS_URL` set to the exact production targets, run:

   ```sh
   PRIVILEGED_SESSION_CUTOVER_CONFIRM=REVOKE_NON_OTP_PRIVILEGED_SESSIONS \
     pnpm exec tsx scripts/revoke-non-otp-privileged-sessions.ts
   ```

   Runtime request/refresh/socket gates also revoke these rows safely, but the
   maintenance command must drive the complete set to zero before privileged
   traffic is admitted. Do not substitute a raw `DELETE`: an affected account
   can also hold mover authority, which requires the transactional cleanup and
   durable outbox used by this command.
5. Prove the invariant with the exact query below. The release gate is
   `non_otp_privileged_sessions = 0`; any non-zero result is a hard stop.

   ```sql
   SELECT count(*) AS non_otp_privileged_sessions
   FROM "sessions" s
   JOIN "users" u ON u."id" = s."userId"
   WHERE s."authMethod" <> 'OTP'::"SessionAuthMethod"
     AND (
       u."activeRole" IN ('ADMIN'::"UserRole", 'SUPER_ADMIN'::"UserRole")
       OR u."roles" && ARRAY['ADMIN', 'SUPER_ADMIN']::"UserRole"[]
     );
   ```

6. Sign each required administrator in through phone OTP, verify its persisted
   session is `OTP`, exercise one authorized REST request and one socket
   connection, rotate its refresh token, and verify `authMethod` remains `OTP`.
7. Confirm that a customer `PASSWORD` session still works, then promote a
   disposable test account and prove REST, refresh, and socket reconnect all
   return the generic unauthorized contract and delete that exact session.
8. Re-open privileged traffic only after the checks above, migration status,
   schema drift, focused auth/security tests, and rollback evidence are green.

## Rollback boundary

Rolling back to an old binary after the migration is forbidden: it would create
default-`LEGACY` sessions without enforcing the privileged gate. Keep the
expanded schema, remove privileged traffic, revoke affected sessions through
the application path, and roll forward with a corrected binary.
