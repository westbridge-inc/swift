import { stableBodyHash } from './checkoutAttempt';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · part 6] One taxi booking intent = one Idempotency-Key.
//
// The ride request contract (CONTRACT.md Rev 2 §3): "the app should ALWAYS
// send one: a new key per new booking intent, the SAME key when retrying that
// request (network error, timeout, app restart)". With it, the server answers
// a retried request whose first answer was lost with the SAME ride
// ("replayed": true) instead of a second booking or a confusing refusal.
//
// The intent is the account plus the canonical hash of the body (the same
// hash the checkout attempt uses): the same trip, retried, is the same key; a
// changed trip — another stop, another order, another class or fare — is a new
// one. The key is spent as soon as the booking is answered or a live ride is
// seen, so booking the same trip again tomorrow is a new booking, never a
// replay of today's. A key older than the window is never re-used either.
//
// The ride flow does not need the checkout's receipt probe: one live ride per
// customer is a server rule, and `GET /rides/active` (polled by the screen) is
// the read the contract names for an unknown outcome.
//
// Pure, so it is proved without a native store; rideRequestAttemptStore.ts
// binds it to the encrypted storage, and a storage fault degrades to memory.
// ---------------------------------------------------------------------------

export const RIDE_REQUEST_ATTEMPT_STORAGE_KEY = 'swift.rides.requestAttempt.v1';
/** How long an unanswered intent's key is re-used for a retry. */
export const RIDE_REQUEST_KEY_TTL_MS = 15 * 60_000;

export interface RideKeyStore {
  get(): string | null;
  set(value: string): void;
  clear(): void;
}

interface RideRequestIntent {
  key: string;
  userId: string;
  bodyHash: string;
  createdAt: number;
}

/** `ride_<base36 ms>_<10 base36 chars>` — inside the server's 8–128 window. */
export function mintRideRequestKey(now: number = Date.now(), random: () => number = Math.random): string {
  const tail = random().toString(36).slice(2, 12).padEnd(10, '0');
  return `ride_${now.toString(36)}_${tail}`;
}

function decode(raw: string | null): RideRequestIntent | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<RideRequestIntent>;
    if (typeof v.key !== 'string' || v.key.length < 8 || v.key.length > 128) return null;
    if (typeof v.userId !== 'string' || typeof v.bodyHash !== 'string' || !v.bodyHash) return null;
    if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return null;
    return { key: v.key, userId: v.userId, bodyHash: v.bodyHash, createdAt: v.createdAt };
  } catch {
    return null;
  }
}

export function createRideRequestAttempt(
  store: RideKeyStore,
  mint: () => string = mintRideRequestKey,
  now: () => number = Date.now,
) {
  let memory: RideRequestIntent | null | undefined;
  const read = (): RideRequestIntent | null => {
    if (memory !== undefined) return memory;
    try { memory = decode(store.get()); } catch { memory = null; }
    return memory;
  };
  const write = (intent: RideRequestIntent | null) => {
    memory = intent;
    try {
      if (intent) store.set(JSON.stringify(intent));
      else store.clear();
    } catch { /* memory still holds the intent for this run */ }
  };
  return {
    /** The key for this request: the same account, the same body and a recent
     *  unanswered intent re-use it (a retry); anything else is a new key. */
    keyFor(body: unknown, userId: string): string {
      const bodyHash = stableBodyHash(body);
      const intent = read();
      if (intent && intent.userId === userId && intent.bodyHash === bodyHash && now() - intent.createdAt < RIDE_REQUEST_KEY_TTL_MS) {
        return intent.key;
      }
      const fresh: RideRequestIntent = { key: mint(), userId, bodyHash, createdAt: now() };
      write(fresh);
      return fresh.key;
    },
    /** The booking was answered (created or replayed), the server refused the
     *  key itself, or a live ride is on screen: this key is spent. */
    settle(): void {
      if (read()) write(null);
    },
  };
}

export type RideRequestAttempt = ReturnType<typeof createRideRequestAttempt>;
