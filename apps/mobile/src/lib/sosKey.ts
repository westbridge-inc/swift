/**
 * One idempotency key per emergency.
 *
 * Lives in `lib/` and imports NOTHING, for the same reason `text-scale.ts`
 * does: the hook that consumes it is React and the suite runs in a node
 * environment, and the property this carries is a safety property rather than
 * a rendering detail. It has to be provable on its own.
 *
 * `POST /safety/sos` collapses repeat presses into a single alert only while
 * the key holds still. A key regenerated per tap would file a fresh alert on
 * every press and bury ops in duplicates at the exact moment they need one
 * clear signal from one person.
 *
 * A frightened person hits the button more than once. That is the normal case
 * here, not the edge case, and it is what this exists for.
 */
export function createSosKeyStore(now: () => number = Date.now) {
  const keys = new Map<string, string>();
  return {
    keyFor(jobId: string): string {
      const existing = keys.get(jobId);
      if (existing) return existing;
      // Stable within this incident, distinct across jobs — a different job is
      // a different emergency and deserves its own alert.
      const raw = `sos-${jobId}-${now()}`;
      // The server floor is 8 (createSchema: min(8).max(128)) and a rejected
      // key means the alert NEVER FILES. Today's ids are 25-char cuids and the
      // clock is 13 digits, so this never binds in production — but that is
      // luck, not design, and the failure mode is a 400 on the one request
      // that must not fail. Guarantee the floor instead of trusting the
      // inputs. (A test with a one-character job id found this at 7.)
      const minted = raw.length >= 8 ? raw : raw.padEnd(8, '0');
      keys.set(jobId, minted);
      return minted;
    },
  };
}
