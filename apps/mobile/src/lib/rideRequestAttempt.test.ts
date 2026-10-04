import { describe, expect, it, vi } from 'vitest';
import { createRideRequestAttempt, mintRideRequestKey, type RideKeyStore } from './rideRequestAttempt';
import { REQUEST_BODY_WITH_ONE_STOP } from './taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · part 6] CONTRACT.md Rev 2 §3: "Idempotency-Key … the app
// should ALWAYS send one: a new key per new booking intent, the SAME key when
// retrying that request (network error, timeout, app restart)."
//
// An attempt whose outcome is unknown keeps its key until it is reconciled —
// however long that takes and whoever signs in meanwhile. It is retired only
// by the answer to THAT request, or by the server's own read of the live ride.
// Every sequence the PR #1426 review gave is here.
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
const noLiveRide = async () => null;
const DAY = 24 * 60 * 60_000;

describe('one booking intent = one key', () => {
  it('a retry of the same body by the same account gets the same key', async () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const first = await attempt.begin(body, 'rider-a', noLiveRide);
    expect(await attempt.begin({ ...body }, 'rider-a', noLiveRide)).toBe(first);
  });

  it('a stop order change is a different body', async () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const two = { ...body, stops: [{ lat: 6.8143, lng: -58.1443, address: 'Camp Street' }, { lat: 6.825, lng: -58.15, address: 'Sheriff Street' }] };
    const first = await attempt.begin(two, 'rider-a', noLiveRide);
    attempt.settle(first, 'rider-a');
    expect(await attempt.begin({ ...two, stops: [...two.stops].reverse() }, 'rider-a', noLiveRide)).not.toBe(first);
  });

  it('the answer to the request spends its key: the same trip later is a new booking', async () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const first = await attempt.begin(body, 'rider-a', noLiveRide);
    attempt.settle(first, 'rider-a');
    expect(await attempt.begin(body, 'rider-a', noLiveRide)).not.toBe(first);
  });
});

describe('an unresolved attempt keeps its key until it is reconciled', () => {
  it('[review 4] the same unanswered booking a day later is still the same key', async () => {
    let now = 1_000_000;
    const attempt = createRideRequestAttempt(memoryStore(), counterMint(), () => now);
    const first = await attempt.begin(body, 'rider-a', noLiveRide);
    now += DAY;
    expect(await attempt.begin(body, 'rider-a', noLiveRide)).toBe(first);
  });

  it('[review 4] A → B → A: account A’s unanswered booking keeps its key', async () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const a = await attempt.begin(body, 'rider-a', noLiveRide);
    const b = await attempt.begin(body, 'rider-b', noLiveRide);
    expect(b).not.toBe(a);
    expect(await attempt.begin(body, 'rider-a', noLiveRide)).toBe(a);
  });

  it('[review 5] A’s late answer settles only A’s attempt: B retries with B’s key', async () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const a = await attempt.begin(body, 'rider-a', noLiveRide);
    const b = await attempt.begin(otherBody, 'rider-b', noLiveRide);
    attempt.settle(a, 'rider-a');
    expect(await attempt.begin(otherBody, 'rider-b', noLiveRide)).toBe(b);
  });

  it('settle needs the exact key AND account: a stray answer retires nothing', async () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const a = await attempt.begin(body, 'rider-a', noLiveRide);
    attempt.settle(a, 'rider-b');
    attempt.settle('ride_some_other_key', 'rider-a');
    expect(await attempt.begin(body, 'rider-a', noLiveRide)).toBe(a);
  });

  it('a new trip while one is unresolved first asks the server about the live ride', async () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const a = await attempt.begin(body, 'rider-a', noLiveRide);
    const read = vi.fn(async () => null);
    const fresh = await attempt.begin(otherBody, 'rider-a', read);
    expect(read).toHaveBeenCalledOnce();
    expect(fresh).not.toBe(a);
    // The old attempt was reconciled (no live ride): it is gone, so retrying
    // the old trip is a new booking, not a replay.
    expect(await attempt.begin(body, 'rider-a', noLiveRide)).not.toBe(a);
  });

  it('a live ride on the server refuses a second booking and mints nothing', async () => {
    const store = memoryStore();
    const attempt = createRideRequestAttempt(store, counterMint());
    await attempt.begin(body, 'rider-a', noLiveRide);
    const before = store.raw;
    await expect(attempt.begin(otherBody, 'rider-a', async () => ({ id: 'ride-live' }))).rejects.toMatchObject({ code: 'RIDE_ALREADY_BOOKED' });
    expect(store.raw).not.toBe(before);
    // The live ride reconciles the old attempt; nothing new was minted.
    expect(JSON.parse(store.raw ?? '{"attempts":[]}').attempts).toEqual([]);
  });

  it('when the server cannot be asked, no new key is minted and the old one survives', async () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const a = await attempt.begin(body, 'rider-a', noLiveRide);
    await expect(attempt.begin(otherBody, 'rider-a', async () => { throw new Error('offline'); })).rejects.toMatchObject({ code: 'RIDE_STILL_CHECKING' });
    expect(await attempt.begin(body, 'rider-a', noLiveRide)).toBe(a);
  });

  it('another account’s unresolved attempt never blocks or reads for this one', async () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    await attempt.begin(body, 'rider-a', noLiveRide);
    const read = vi.fn(async () => ({ id: 'a-ride' }));
    await attempt.begin(otherBody, 'rider-b', read);
    expect(read).not.toHaveBeenCalled();
  });

  it('a live ride seen on screen reconciles only that account’s attempts', async () => {
    const attempt = createRideRequestAttempt(memoryStore(), counterMint());
    const a = await attempt.begin(body, 'rider-a', noLiveRide);
    const b = await attempt.begin(body, 'rider-b', noLiveRide);
    attempt.liveRideSeen('rider-a');
    expect(await attempt.begin(body, 'rider-a', noLiveRide)).not.toBe(a);
    expect(await attempt.begin(body, 'rider-b', noLiveRide)).toBe(b);
  });
});

describe('an app restart retries with the same key', () => {
  it('a new process reading the same storage reuses the unanswered key', async () => {
    const store = memoryStore();
    const first = await createRideRequestAttempt(store, counterMint()).begin(body, 'rider-a', noLiveRide);
    const afterRestart = createRideRequestAttempt(store, () => 'ride_never_minted');
    expect(await afterRestart.begin(body, 'rider-a', noLiveRide)).toBe(first);
  });

  it('storage that fails still protects a retry in memory', async () => {
    const broken: RideKeyStore = { get: () => { throw new Error('locked'); }, set: () => { throw new Error('locked'); }, clear: () => { throw new Error('locked'); } };
    const attempt = createRideRequestAttempt(broken, counterMint());
    const first = await attempt.begin(body, 'rider-a', noLiveRide);
    expect(await attempt.begin(body, 'rider-a', noLiveRide)).toBe(first);
  });

  it('a corrupt stored record is ignored', async () => {
    const store = memoryStore();
    store.raw = '{"attempts":[{"key":"x"}]}';
    expect(await createRideRequestAttempt(store, () => 'ride_fresh_0001').begin(body, 'rider-a', noLiveRide)).toBe('ride_fresh_0001');
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
