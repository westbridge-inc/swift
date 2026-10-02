import { describe, expect, it } from 'vitest';
import { RIDE_REQUEST_KEY_TTL_MS, createRideRequestAttempt, mintRideRequestKey, type RideKeyStore } from './rideRequestAttempt';
import { REQUEST_BODY_WITH_ONE_STOP } from './taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · part 6] CONTRACT.md Rev 2 §3: "Idempotency-Key … the app
// should ALWAYS send one: a new key per new booking intent, the SAME key when
// retrying that request (network error, timeout, app restart)."
// ---------------------------------------------------------------------------

function memoryStore(): RideKeyStore & { raw: string | null } {
  const s = {
    raw: null as string | null,
    get: () => s.raw,
    set: (v: string) => { s.raw = v; },
    clear: () => { s.raw = null; },
  };
  return s;
}

function counterMint() {
  let n = 0;
  return () => `ride_test_${String(++n).padStart(4, '0')}`;
}

const body = REQUEST_BODY_WITH_ONE_STOP;
const otherBody = { ...REQUEST_BODY_WITH_ONE_STOP, rideClass: 'COMFORT', expectedFare: 3800 };

describe('one booking intent = one key', () => {
  it('a retry of the same body by the same account gets the same key', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const first = attempt.keyFor(body, 'rider-1');
    expect(attempt.keyFor({ ...body }, 'rider-1')).toBe(first);
  });

  it('a different body is a new intent and a new key', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const first = attempt.keyFor(body, 'rider-1');
    expect(attempt.keyFor(otherBody, 'rider-1')).not.toBe(first);
  });

  it('a stop order change is a different body', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const two = { ...body, stops: [{ lat: 6.8143, lng: -58.1443, address: 'Camp Street' }, { lat: 6.825, lng: -58.15, address: 'Sheriff Street' }] };
    const first = attempt.keyFor(two, 'rider-1');
    expect(attempt.keyFor({ ...two, stops: [...two.stops].reverse() }, 'rider-1')).not.toBe(first);
  });

  it('another account never inherits the key', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const first = attempt.keyFor(body, 'rider-1');
    expect(attempt.keyFor(body, 'rider-2')).not.toBe(first);
  });

  it('once the booking is answered the key is spent: the same trip later is a new booking', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const first = attempt.keyFor(body, 'rider-1');
    attempt.settle();
    expect(attempt.keyFor(body, 'rider-1')).not.toBe(first);
  });

  it('an old intent expires', () => {
    let now = 1_000_000;
    const attempt = createRideRequestAttempt(memoryStore(), counterMint(), () => now);
    const first = attempt.keyFor(body, 'rider-1');
    now += RIDE_REQUEST_KEY_TTL_MS - 1;
    expect(attempt.keyFor(body, 'rider-1')).toBe(first);
    now += 2;
    expect(attempt.keyFor(body, 'rider-1')).not.toBe(first);
  });
});

describe('an app restart retries with the same key', () => {
  it('a new process reading the same storage reuses the unanswered key', () => {
    const store = memoryStore();
    const first = createRideRequestAttempt(store, counterMint()).keyFor(body, 'rider-1');
    const afterRestart = createRideRequestAttempt(store, () => 'ride_never_minted');
    expect(afterRestart.keyFor(body, 'rider-1')).toBe(first);
  });

  it('storage that fails still protects a retry in memory', () => {
    const broken: RideKeyStore = { get: () => { throw new Error('locked'); }, set: () => { throw new Error('locked'); }, clear: () => { throw new Error('locked'); } };
    const attempt = createRideRequestAttempt(broken, counterMint());
    const first = attempt.keyFor(body, 'rider-1');
    expect(attempt.keyFor(body, 'rider-1')).toBe(first);
  });

  it('a corrupt stored record is ignored', () => {
    const store = memoryStore();
    store.raw = '{"key":"x"}';
    expect(createRideRequestAttempt(store, () => 'ride_fresh_0001').keyFor(body, 'rider-1')).toBe('ride_fresh_0001');
  });
});

describe('the key itself', () => {
  it('fits the server’s 8..128 window', () => {
    const key = mintRideRequestKey(1_790_000_000_000, () => 0.123456789);
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toMatch(/^ride_[0-9a-z]+_[0-9a-z]{10}$/);
  });
});
