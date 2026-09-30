import { positiveDurationMs } from '../../utils/async-lifecycle';
import { isProduction } from '../../utils/runtime-mode';

// [G5-F6 · AX337 · AX352] The settlement publication lease in ONE place: the
// default, the test and drill override, and the boot guard that keeps the
// override out of production. Its own module so the boot guard does not load
// the settlement import (and the database client) to read a number.

/** A publisher silent this long has died, and its import may be taken over.
 *  Far above the heartbeat and above any one row of ingest. */
export const PUBLICATION_LEASE_MS = 5 * 60_000;
/** A publisher renews its lease at least this often while it credits rows. */
export const PUBLICATION_HEARTBEAT_MS = 15_000;
/** TEST AND DRILL ONLY: shortens the lease so it can lapse inside a test or a
 *  drill. Production refuses to boot with any value below
 *  PUBLICATION_LEASE_MS [AX352]: a short lease can lapse while a slow row
 *  replays, before any progress is written, and strand the unpaid tail of a
 *  settlement file. */
export const PUBLICATION_LEASE_ENV = 'SETTLEMENT_PUBLICATION_LEASE_MS';

/** The lease in force, read at call time like the hold, never under a second. */
export function publicationLeaseMs(env: Record<string, string | undefined> = process.env): number {
  return Math.max(1_000, positiveDurationMs(env[PUBLICATION_LEASE_ENV], PUBLICATION_LEASE_MS));
}

/** The heartbeat beats at a quarter of the lease or faster. */
export function publicationHeartbeatMs(env: Record<string, string | undefined> = process.env): number {
  return Math.min(PUBLICATION_HEARTBEAT_MS, Math.floor(publicationLeaseMs(env) / 4));
}

/** [AX352] The boot guard (assertSafeBootConfig): in production the override
 *  may only be unset, or no shorter than the default. Anything else, an
 *  unreadable value included, refuses to start. */
export function assertSettlementPublicationLeaseConfig(env: Record<string, string | undefined> = process.env): void {
  const raw = env[PUBLICATION_LEASE_ENV];
  if (raw === undefined || raw === '' || !isProduction(env)) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < PUBLICATION_LEASE_MS) {
    throw new Error(`FATAL: ${PUBLICATION_LEASE_ENV} is a test and drill setting: production refuses any value below the ${PUBLICATION_LEASE_MS / 60_000}-minute default (got ${JSON.stringify(raw)}). A short lease can lapse while a slow row replays, before any progress is written, and strand the unpaid tail of a settlement file. Unset it. Refusing to start.`);
  }
}
