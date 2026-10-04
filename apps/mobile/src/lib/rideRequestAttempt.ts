import { stableBodyHash } from './checkoutAttempt';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · part 6] One taxi booking intent = one Idempotency-Key.
//
// The ride request contract (CONTRACT.md Rev 2 §3): "the app should ALWAYS
// send one: a new key per new booking intent, the SAME key when retrying that
// request (network error, timeout, app restart)". With it, the server answers
// a retried request whose first answer was lost with the SAME ride
// ("replayed": true) instead of a second booking.
//
// An ATTEMPT is the account plus the canonical hash of the body (the same hash
// the checkout attempt uses), and it keeps its key until its outcome is KNOWN:
//
//   * the answer to that very request — a ride, a replay, or a refusal that
//     the server says wrote nothing — retires that attempt and no other
//     (`settle(key, userId)`: a late answer for account A can never retire
//     account B's attempt);
//   * the server's own read of the live ride: before a NEW key is minted while
//     another attempt of the same account is unresolved, `begin` asks
//     `GET /rides/active`. A live ride means the booking already exists (or no
//     second one could be made): nothing is minted. No live ride means the old
//     attempt is reconciled and a new key is safe. If the read fails, nothing
//     is minted either — an unknown outcome is never guessed;
//   * a live ride on screen (`liveRideSeen`) reconciles that account's
//     attempts the same way.
//
// Nothing expires on a clock, and an account switch (A → B → A) leaves each
// account's attempt where it was. Persisted (rideRequestAttemptStore.ts) so an
// app killed mid-request retries with the same key; a storage fault degrades
// to memory. Pure, so every sequence is proved without a native store.
// ---------------------------------------------------------------------------

export const RIDE_REQUEST_ATTEMPT_STORAGE_KEY = 'swift.rides.requestAttempt.v2';
/** Old, single-intent records (v1) are not read: an attempt without its
 *  account and body cannot be matched safely. */
const MAX_ATTEMPTS = 20;

export interface RideKeyStore {
  get(): string | null;
  set(value: string): void;
  clear(): void;
}

interface RideRequestAttemptRecord {
  key: string;
  userId: string;
  bodyHash: string;
  createdAt: number;
}

/** Why `begin` minted nothing — shaped like the server's refusal envelope so
 *  the booking screen shows it the way it shows any refusal. */
export class RideAttemptBlocked extends Error {
  readonly response: { status: number; data: { success: false; error: { code: string; message: string } } };
  constructor(readonly code: 'RIDE_ALREADY_BOOKED' | 'RIDE_STILL_CHECKING', message: string) {
    super(message);
    this.response = { status: 409, data: { success: false, error: { code, message } } };
  }
}

/** `ride_<base36 ms>_<10 base36 chars>` — inside the server's 8–128 window. */
export function mintRideRequestKey(now: number = Date.now(), random: () => number = Math.random): string {
  const tail = random().toString(36).slice(2, 12).padEnd(10, '0');
  return `ride_${now.toString(36)}_${tail}`;
}

function decode(raw: string | null): RideRequestAttemptRecord[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { attempts?: unknown };
    if (!Array.isArray(v.attempts)) return [];
    return v.attempts.flatMap((a) => {
      const r = a as Partial<RideRequestAttemptRecord>;
      if (typeof r.key !== 'string' || r.key.length < 8 || r.key.length > 128) return [];
      if (typeof r.userId !== 'string' || !r.userId || typeof r.bodyHash !== 'string' || !r.bodyHash) return [];
      if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return [];
      return [{ key: r.key, userId: r.userId, bodyHash: r.bodyHash, createdAt: r.createdAt }];
    });
  } catch {
    return [];
  }
}

export function createRideRequestAttempt(
  store: RideKeyStore,
  mint: () => string = mintRideRequestKey,
  now: () => number = Date.now,
) {
  let memory: RideRequestAttemptRecord[] | undefined;
  const read = (): RideRequestAttemptRecord[] => {
    if (memory !== undefined) return memory;
    try { memory = decode(store.get()); } catch { memory = []; }
    return memory;
  };
  const write = (attempts: RideRequestAttemptRecord[]) => {
    memory = attempts.slice(-MAX_ATTEMPTS);
    try {
      if (memory.length) store.set(JSON.stringify({ version: 2, attempts: memory }));
      else store.clear();
    } catch { /* memory still holds the attempts for this run */ }
  };
  const dropUser = (userId: string) => write(read().filter((a) => a.userId !== userId));
  return {
    /**
     * The key for this request. The same account and body re-use their
     * unresolved attempt's key, however old (a retry). A new trip while this
     * account has another unresolved attempt first asks the server for the
     * live ride (`readLiveRide`): a live ride refuses with RIDE_ALREADY_BOOKED,
     * a failed read with RIDE_STILL_CHECKING — neither mints a key.
     */
    async begin(body: unknown, userId: string, readLiveRide: () => Promise<unknown>): Promise<string> {
      const bodyHash = stableBodyHash(body);
      const same = read().find((a) => a.userId === userId && a.bodyHash === bodyHash);
      if (same) return same.key;
      if (read().some((a) => a.userId === userId)) {
        let live: unknown;
        try {
          live = await readLiveRide();
        } catch {
          throw new RideAttemptBlocked('RIDE_STILL_CHECKING', 'We couldn’t check your last booking. Check your connection, then tap Request again.');
        }
        // Either way the server has answered for this account's old attempts.
        dropUser(userId);
        if (live) throw new RideAttemptBlocked('RIDE_ALREADY_BOOKED', 'You already have a ride booked. Opening it now.');
        // A retry of the same trip may have raced in while the server was asked.
        const raced = read().find((a) => a.userId === userId && a.bodyHash === bodyHash);
        if (raced) return raced.key;
      }
      const fresh: RideRequestAttemptRecord = { key: mint(), userId, bodyHash, createdAt: now() };
      write([...read(), fresh]);
      return fresh.key;
    },
    /** The answer to the request sent with `key` by `userId` (a ride, a replay,
     *  or a refusal that wrote nothing): that attempt — and only it — is done. */
    settle(key: string, userId: string): void {
      const left = read().filter((a) => !(a.key === key && a.userId === userId));
      if (left.length !== read().length) write(left);
    },
    /** This account's live ride is on screen: its unresolved attempts are
     *  reconciled by the server's own read (no second ride can be booked). */
    liveRideSeen(userId: string): void {
      if (read().some((a) => a.userId === userId)) dropUser(userId);
    },
  };
}

export type RideRequestAttempt = ReturnType<typeof createRideRequestAttempt>;
