/**
 * An ONLINE mover must own a location session. Production enforces it in the
 * database:
 *
 *   riders_online_requires_location_owner
 *   drivers_online_requires_location_owner
 *   CHECK ((NOT "isOnline") OR ("locationSessionId" IS NOT NULL))
 *
 * A fixture that sets `isOnline: true` and leaves `locationSessionId` null is
 * therefore constructing a row production cannot hold — and any test standing
 * on it is grading behaviour over an impossible state.
 *
 * It went unnoticed for a long time because the CI api-test database is built
 * with `prisma db push`, which reflects the Prisma schema and never runs
 * migration SQL, so it carries none of the CHECK constraints (2 of 29), none
 * of the triggers (0 of 13) and none of the RLS policies (0 of 54) that a
 * migrated database has. Against a real migrated database this single invariant
 * accounted for 315 violations across 20 test files.
 *
 * `locationSessionId` is a bare column with no foreign key — it names the auth
 * session that owns the mover's location stream. Pass the real session id when
 * the fixture has one; that is always better, because revocation tests read it.
 * Where a fixture has no session and does not need one, `syntheticLocationOwner`
 * gives a non-null marker, the shape `activation-authority.test.ts` already uses.
 */

let counter = 0;

/** A non-null owner marker for fixtures with no auth session of their own.
 *
 *  Deliberately NOT a wrapper that also sets `isOnline`/`isAvailable`: several
 *  fixtures bring a mover online while holding `isAvailable: false` on purpose
 *  (a mover mid-job), and a helper that forced the pair would quietly change
 *  what those tests mean. The invariant is about ownership, so this supplies
 *  exactly the owner and nothing else. */
export function syntheticLocationOwner(label: string): string {
  counter += 1;
  return `test-loc-${label}-${counter}`;
}
