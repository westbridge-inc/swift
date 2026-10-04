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
// An ATTEMPT is one account plus the canonical hash of one request body (the
// same hash the checkout attempt uses). Its key lives until ITS OWN request
// gets a definitive answer — a ride (new or replayed), or a refusal the server
// proves wrote nothing — and nothing else retires it: no clock, no other
// account's activity, no read of the live ride, no other trip. A different
// trip simply gets its own key and leaves older unresolved attempts alone.
//
// The store has ONE writer and no awaits: every read-modify-write finishes in
// one synchronous step, so two identical taps in flight share one key. It
// re-reads the persisted slot on every step (so two instances on one slot see
// each other). A save that FAILS never loses a key: memory stays the
// authoritative copy until a save succeeds — a later read merges the saved
// list into it (unsaved records win; an answer settled while unsaved stays
// settled) and retries the save. While saving keeps failing, a NEW trip is
// refused in plain words; the unsaved trip itself can still be retried.
// An unresolved attempt is never evicted: when the store is full, a NEW
// booking is refused with a plain message instead.
// ---------------------------------------------------------------------------

export const RIDE_REQUEST_ATTEMPT_STORAGE_KEY = 'swift.rides.requestAttempt.v3';
/** The most unresolved attempts the phone holds at once (all accounts). */
export const RIDE_REQUEST_ATTEMPT_CAP = 50;

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

/** Why no key was given — shaped like the server's refusal envelope so the
 *  booking screen shows it the way it shows any refusal. */
export class RideAttemptBlocked extends Error {
  readonly response: { status: number; data: { success: false; error: { code: string; message: string } } };
  constructor(readonly code: 'RIDE_KEYS_FULL' | 'RIDE_KEYS_UNSAVED', message: string) {
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
  cap: number = RIDE_REQUEST_ATTEMPT_CAP,
) {
  // Memory is the last state this instance wrote. While `unsaved`, it holds
  // changes storage has not taken yet and is the authority over what a read
  // returns; `settledUnsaved` remembers answers retired in that window so the
  // stale saved list cannot bring them back.
  let memory: RideRequestAttemptRecord[] = [];
  let unsaved = false;
  const settledUnsaved = new Set<string>();
  const idOf = (a: Pick<RideRequestAttemptRecord, 'userId' | 'key'>) => `${a.userId}\u0000${a.key}`;
  const save = (attempts: RideRequestAttemptRecord[]): boolean => {
    try {
      if (attempts.length) store.set(JSON.stringify({ version: 3, attempts }));
      else store.clear();
      unsaved = false;
      settledUnsaved.clear();
      return true;
    } catch {
      unsaved = true;
      return false;
    }
  };
  const read = (): RideRequestAttemptRecord[] => {
    let saved: RideRequestAttemptRecord[] | null;
    try { saved = decode(store.get()); } catch { saved = null; }
    if (!unsaved) {
      if (saved) memory = saved;
      return memory;
    }
    // Unsaved changes win; records saved meanwhile (another instance) join
    // them unless this instance already settled them.
    if (saved) {
      const merged = [...memory];
      for (const r of saved) {
        if (settledUnsaved.has(idOf(r))) continue;
        if (merged.some((m) => m.userId === r.userId && (m.bodyHash === r.bodyHash || m.key === r.key))) continue;
        merged.push(r);
      }
      memory = merged;
    }
    save(memory); // retry the save that failed
    return memory;
  };
  const write = (attempts: RideRequestAttemptRecord[]): boolean => {
    memory = attempts;
    return save(attempts);
  };
  return {
    /**
     * The key for this request, in one synchronous step. The same account and
     * body re-use their unresolved attempt's key, however old; any other trip
     * gets a key of its own. A full store refuses a NEW trip (RIDE_KEYS_FULL)
     * rather than drop an attempt whose outcome is still unknown.
     */
    begin(body: unknown, userId: string): string {
      const bodyHash = stableBodyHash(body);
      const attempts = read();
      const same = attempts.find((a) => a.userId === userId && a.bodyHash === bodyHash);
      if (same) return same.key;
      if (unsaved) {
        throw new RideAttemptBlocked('RIDE_KEYS_UNSAVED',
          'This phone can’t save your booking safely right now. Close and reopen the app, then try again, or contact support.');
      }
      if (attempts.length >= cap) {
        throw new RideAttemptBlocked('RIDE_KEYS_FULL',
          'Too many bookings on this phone are still waiting for an answer. Check your connection and try one of them again, or contact support.');
      }
      const fresh: RideRequestAttemptRecord = { key: mint(), userId, bodyHash, createdAt: now() };
      write([...attempts, fresh]);
      return fresh.key;
    },
    /** The definitive answer to the request sent with `key` by `userId`: that
     *  attempt — and only it — is done. Anything else retires nothing. */
    settle(key: string, userId: string): void {
      const attempts = read();
      const left = attempts.filter((a) => !(a.key === key && a.userId === userId));
      if (left.length === attempts.length) return;
      if (!write(left)) settledUnsaved.add(idOf({ userId, key }));
    },
  };
}

export type RideRequestAttempt = ReturnType<typeof createRideRequestAttempt>;
