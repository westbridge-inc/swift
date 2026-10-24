import { describe, expect, it } from 'vitest';
import { createRideRequestAttempt, mintRideRequestKey, type RideKeyStore } from './rideRequestAttempt';
import { REQUEST_BODY_WITH_ONE_STOP } from './taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · part 6] CONTRACT.md Rev 2 §3: "Idempotency-Key … the app
// should ALWAYS send one: a new key per new booking intent, the SAME key when
// retrying that request (network error, timeout, app restart)."
//
// An attempt is one account + one request body. It keeps its key until ITS
// OWN request gets a definitive answer — never on a clock, never on another
// account's activity, never on a read of some other state. A different trip
// simply gets its own key and leaves older unresolved attempts alone. Every
// sequence from the PR #1426 reviews is here.
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
const DAY = 24 * 60 * 60_000;

describe('one booking intent = one key', () => {
  it('a retry of the same body by the same account gets the same key', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const first = attempt.begin(body, 'rider-a');
    expect(attempt.begin({ ...body }, 'rider-a')).toBe(first);
  });

  it('the definitive answer to the request spends its key: the same trip later is a new booking', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const first = attempt.begin(body, 'rider-a');
    attempt.settle(first, 'rider-a');
    expect(attempt.begin(body, 'rider-a')).not.toBe(first);
  });

  it('a stop order change is a different body, with its own key', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const two = { ...body, stops: [{ lat: 6.8143, lng: -58.1443, address: 'Camp Street' }, { lat: 6.825, lng: -58.15, address: 'Sheriff Street' }] };
    expect(attempt.begin({ ...two, stops: [...two.stops].reverse() }, 'rider-a')).not.toBe(attempt.begin(two, 'rider-a'));
  });
});

describe('an unresolved attempt keeps its key until its own answer', () => {
  it('[review 1.4] the same unanswered booking a day later is still the same key', () => {
    let now = 1_000_000;
    const attempt = createRideRequestAttempt(memoryStore(), counterMint(), () => now);
    const first = attempt.begin(body, 'rider-a');
    now += DAY;
    expect(attempt.begin(body, 'rider-a')).toBe(first);
  });

  it('[review 2.1] a different trip gets its own key and leaves the unresolved one alone: retrying A keeps A’s key', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const a = attempt.begin(body, 'rider-a');
    const b = attempt.begin(otherBody, 'rider-a');
    expect(b).not.toBe(a);
    expect(attempt.begin(body, 'rider-a')).toBe(a);
    expect(attempt.begin(otherBody, 'rider-a')).toBe(b);
  });

  it('[review 2.1] concurrent identical requests share one key', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const keys = [attempt.begin(otherBody, 'rider-a'), attempt.begin({ ...otherBody }, 'rider-a')];
    expect(keys[1]).toBe(keys[0]);
  });

  it('two app instances on one store see each other’s attempts at once', () => {
    const store = memoryStore();
    const one = createRideRequestAttempt(store, counterMint());
    const two = createRideRequestAttempt(store, () => 'ride_never_minted');
    const key = one.begin(body, 'rider-a');
    expect(two.begin(body, 'rider-a')).toBe(key);
  });

  it('[review 1.4] A → B → A: account A’s unanswered booking keeps its key', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const a = attempt.begin(body, 'rider-a');
    expect(attempt.begin(body, 'rider-b')).not.toBe(a);
    expect(attempt.begin(body, 'rider-a')).toBe(a);
  });

  it('[review 1.5] A’s late answer settles only A’s attempt: B retries with B’s key', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const a = attempt.begin(body, 'rider-a');
    const b = attempt.begin(otherBody, 'rider-b');
    attempt.settle(a, 'rider-a');
    expect(attempt.begin(otherBody, 'rider-b')).toBe(b);
  });

  it('settle needs the exact key AND account: a stray answer retires nothing', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const a = attempt.begin(body, 'rider-a');
    attempt.settle(a, 'rider-b');
    attempt.settle('ride_some_other_key', 'rider-a');
    expect(attempt.begin(body, 'rider-a')).toBe(a);
  });
});

describe('[review 2.4] the store never drops an unresolved attempt', () => {
  it('21 accounts with unanswered bookings: the first account still has its key', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const first = attempt.begin(body, 'rider-0');
    for (let i = 1; i <= 20; i++) attempt.begin(body, `rider-${i}`);
    expect(attempt.begin(body, 'rider-0')).toBe(first);
  });

  it('at the cap a NEW booking is refused with a clear message; nothing is evicted', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint(), Date.now, 3);
    const keys = ['rider-a', 'rider-b', 'rider-c'].map((u) => attempt.begin(body, u));
    let refused: unknown;
    try { attempt.begin(body, 'rider-d'); } catch (e) { refused = e; }
    expect(refused).toMatchObject({ code: 'RIDE_KEYS_FULL', response: { data: { error: { code: 'RIDE_KEYS_FULL' } } } });
    expect((refused as Error).message).toMatch(/still waiting for an answer/);
    // Every unresolved attempt is still there, and its own retry still works.
    expect(['rider-a', 'rider-b', 'rider-c'].map((u) => attempt.begin(body, u))).toEqual(keys);
  });

  it('a settled attempt frees its place', () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint(), Date.now, 1);
    const a = attempt.begin(body, 'rider-a');
    attempt.settle(a, 'rider-a');
    expect(() => attempt.begin(body, 'rider-b')).not.toThrow();
  });
});

/** A slot whose writes fail while `failing` is set; reads always work and
 *  return whatever was last saved successfully (stale while writes fail). */
function flakyStore(initial: string | null = null) {
  const s = {
    raw: initial,
    failing: false,
    writes: 0,
    get: () => s.raw,
    set: (v: string) => { s.writes++; if (s.failing) throw new Error('disk full'); s.raw = v; },
    clear: () => { s.writes++; if (s.failing) throw new Error('disk full'); s.raw = null; },
  };
  return s;
}

describe('[review 3] a failed save never loses an unresolved key', () => {
  it('the save fails, the answer is lost, the retry of the same trip carries the SAME key', () => {
    // Another account's booking is already saved, so later reads succeed and
    // return that (stale) list — it does not hold rider-a's new attempt.
    const store = flakyStore();
    const attempt = createRideRequestAttempt(store, counterMint());
    attempt.begin(otherBody, 'rider-z');
    store.failing = true;
    const first = attempt.begin(body, 'rider-a');
    expect(JSON.parse(store.raw!).attempts.map((a: { userId: string }) => a.userId)).toEqual(['rider-z']);
    expect(attempt.begin(body, 'rider-a')).toBe(first);
  });

  it('the save fails, then storage recovers: the key is the same and is saved for good', () => {
    const store = flakyStore();
    const attempt = createRideRequestAttempt(store, counterMint());
    store.failing = true;
    const first = attempt.begin(body, 'rider-a');
    store.failing = false;
    expect(attempt.begin(body, 'rider-a')).toBe(first);
    // Saved now: a fresh process on the same slot finds it.
    expect(createRideRequestAttempt(store, () => 'ride_never_minted').begin(body, 'rider-a')).toBe(first);
  });

  it('while saving keeps failing, a NEW trip is refused in plain words; the unsaved trip can still be retried', () => {
    const store = flakyStore();
    const attempt = createRideRequestAttempt(store, counterMint());
    store.failing = true;
    const first = attempt.begin(body, 'rider-a');
    let refused: unknown;
    try { attempt.begin(otherBody, 'rider-a'); } catch (e) { refused = e; }
    expect(refused).toMatchObject({ code: 'RIDE_KEYS_UNSAVED', response: { data: { error: { code: 'RIDE_KEYS_UNSAVED' } } } });
    expect((refused as Error).message).toMatch(/can’t save your booking/);
    expect(attempt.begin(body, 'rider-a')).toBe(first);
  });

  it('a failing save cannot slip a booking past the cap', () => {
    const store = flakyStore();
    const attempt = createRideRequestAttempt(store, counterMint(), Date.now, 1);
    store.failing = true;
    attempt.begin(body, 'rider-a');
    store.failing = false;
    expect(() => attempt.begin(body, 'rider-b')).toThrow(/still waiting for an answer/);
  });

  it('an answer settled while saving failed stays settled when the stale list is read back', () => {
    const store = flakyStore();
    const attempt = createRideRequestAttempt(store, counterMint());
    const first = attempt.begin(body, 'rider-a');
    store.failing = true;
    attempt.settle(first, 'rider-a');
    store.failing = false;
    expect(attempt.begin(body, 'rider-a')).not.toBe(first);
  });

  it('records another app instance saved meanwhile are kept, the unsaved one too', () => {
    const store = flakyStore();
    const one = createRideRequestAttempt(store, counterMint());
    const two = createRideRequestAttempt(store, () => 'ride_from_two_0001');
    store.failing = true;
    const unsaved = one.begin(body, 'rider-a');
    store.failing = false;
    const fromTwo = two.begin(otherBody, 'rider-b');
    expect(one.begin(body, 'rider-a')).toBe(unsaved);
    expect(one.begin(otherBody, 'rider-b')).toBe(fromTwo);
  });
});

describe('an app restart retries with the same key', () => {
  it('a new process reading the same storage reuses the unanswered key', () => {
    const store = memoryStore();
    const first = createRideRequestAttempt(store, counterMint()).begin(body, 'rider-a');
    expect(createRideRequestAttempt(store, () => 'ride_never_minted').begin(body, 'rider-a')).toBe(first);
  });

  it('storage that fails still protects a retry in memory', () => {
    const broken: RideKeyStore = { get: () => { throw new Error('locked'); }, set: () => { throw new Error('locked'); }, clear: () => { throw new Error('locked'); } };
    const attempt = createRideRequestAttempt(broken, counterMint());
    const first = attempt.begin(body, 'rider-a');
    expect(attempt.begin(body, 'rider-a')).toBe(first);
  });

  it('a corrupt stored record is ignored', () => {
    const store = memoryStore();
    store.raw = '{"attempts":[{"key":"x"}]}';
    expect(createRideRequestAttempt(store, () => 'ride_fresh_0001').begin(body, 'rider-a')).toBe('ride_fresh_0001');
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
