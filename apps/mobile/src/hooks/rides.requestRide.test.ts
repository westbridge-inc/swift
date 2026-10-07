import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';
import { REQUEST_BODY_WITH_ONE_STOP } from '../lib/taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · part 6] The REAL useRequestRide mutation over the REAL
// booking-key store (an in-memory slot). Only the transport and the session
// store are stand-ins. Every sequence from the PR #1426 re-review:
//   * a 500 (or any unknown outcome) keeps the key for the retry;
//   * only a 4xx refusal the contract says wrote nothing retires it;
//   * the request is pinned to the session that tapped Request, and an
//     account switch before it leaves the phone sends nothing;
//   * concurrent identical requests share one key.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  class BoundaryError extends Error {}
  return {
    BoundaryError,
    current: null as AuthSessionSnapshot | null,
    request: vi.fn(),
    invalidateQueries: vi.fn(),
  };
});

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => options,
  useQuery: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock('../services/api', () => ({ rideApi: { request: mocks.request } }));
vi.mock('./customer', () => ({ customerKeys: { homeAll: ['customer', 'home'] } }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../stores/authStore', () => ({
  AuthSessionBoundaryError: mocks.BoundaryError,
  getAuthSessionSnapshot: () => mocks.current,
  requireAuthSessionSnapshot: () => {
    if (!mocks.current) throw new mocks.BoundaryError();
    return { ...mocks.current };
  },
  requireAuthSessionForPrincipal: (owner: AuthSessionSnapshot) => {
    if (!mocks.current || mocks.current.userId !== owner.userId || mocks.current.generation !== owner.generation) throw new mocks.BoundaryError();
    return { ...mocks.current };
  },
}));
vi.mock('../lib/rideRequestAttemptStore', async () => {
  const { createRideRequestAttempt } = await vi.importActual<typeof import('../lib/rideRequestAttempt')>('../lib/rideRequestAttempt');
  let raw: string | null = null;
  let n = 0;
  return {
    rideRequestAttempt: createRideRequestAttempt(
      { get: () => raw, set: (v) => { raw = v; }, clear: () => { raw = null; } },
      () => `ride_test_${String(++n).padStart(4, '0')}`,
    ),
  };
});

import { useRequestRide } from './rides';
import { rideRequestAttempt } from '../lib/rideRequestAttemptStore';

const accountA: AuthSessionSnapshot = { userId: 'account-a', generation: 1, accessToken: 'access-a', refreshToken: 'refresh-a' };
const accountB: AuthSessionSnapshot = { userId: 'account-b', generation: 2, accessToken: 'access-b', refreshToken: 'refresh-b' };
type Vars = typeof REQUEST_BODY_WITH_ONE_STOP & { authSession?: AuthSessionSnapshot };
const useBooking = () => useRequestRide() as unknown as { mutationFn: (v: Vars) => Promise<unknown> };
const useBook = (session: AuthSessionSnapshot = accountA) => useBooking().mutationFn({ ...REQUEST_BODY_WITH_ONE_STOP, authSession: session });
const keyOf = (call: number) => mocks.request.mock.calls[call]![1] as string;
const answer = (status: number, code?: string) => Object.assign(new Error(`HTTP ${status}`), {
  response: { status, data: code ? { success: false, error: { code, message: code } } : '<html>bad gateway</html>' },
});
const network = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
const created = { data: { success: true, data: { ride: { id: 'ride-1' } } } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.current = { ...accountA };
  // Retire whatever earlier tests left: each test starts with no attempts.
  for (const user of ['account-a', 'account-b']) {
    for (let i = 0; i < 4; i++) {
      const key = rideRequestAttempt.begin(REQUEST_BODY_WITH_ONE_STOP, user);
      rideRequestAttempt.settle(key, user);
    }
  }
});

describe('the request is pinned to the session that tapped Request', () => {
  it('sends the body (no session in it), the key and the captured session', async () => {
    mocks.request.mockResolvedValue(created);
    await useBook();
    const [sentBody, key, session] = mocks.request.mock.calls[0]!;
    expect(sentBody).toEqual(REQUEST_BODY_WITH_ONE_STOP);
    expect(key).toMatch(/^ride_test_/);
    expect(session).toMatchObject({ userId: 'account-a', accessToken: 'access-a' });
  });

  it('[review 3.3] the account changed before sending: nothing is sent and A’s key is not used for B', async () => {
    mocks.current = { ...accountB };
    await expect(useBook(accountA)).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('no session at all: nothing is sent', async () => {
    mocks.current = null;
    await expect(useBooking().mutationFn({ ...REQUEST_BODY_WITH_ONE_STOP })).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

describe('only a refusal that wrote nothing retires the key', () => {
  it.each([
    ['[review 3.2] 500 INTERNAL_ERROR', () => answer(500, 'INTERNAL_ERROR')],
    ['503 RIDE_REQUEST_OUTCOME_UNKNOWN', () => answer(503, 'RIDE_REQUEST_OUTCOME_UNKNOWN')],
    ['503 ROUTE_UNAVAILABLE (a 5xx)', () => answer(503, 'ROUTE_UNAVAILABLE')],
    ['409 DUPLICATE_REQUEST (a twin in flight)', () => answer(409, 'DUPLICATE_REQUEST')],
    ['a 4xx code the app does not know', () => answer(409, 'SOMETHING_NEW')],
    ['a 502 with no envelope', () => answer(502)],
    ['a network error', network],
  ])('%s → the retry carries the SAME key', async (_label, failure) => {
    mocks.request.mockRejectedValueOnce(failure()).mockResolvedValueOnce(created);
    await expect(useBook()).rejects.toBeTruthy();
    await useBook();
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it.each([
    ['400 STOP_TOO_CLOSE', 400, 'STOP_TOO_CLOSE'],
    ['400 VALIDATION_ERROR', 400, 'VALIDATION_ERROR'],
    ['409 NO_DRIVERS_NEARBY', 409, 'NO_DRIVERS_NEARBY'],
    ['409 MULTI_STOP_UNAVAILABLE', 409, 'MULTI_STOP_UNAVAILABLE'],
    ['409 FARE_CHANGED', 409, 'FARE_CHANGED'],
    ['422 IDEMPOTENCY_KEY_REUSED', 422, 'IDEMPOTENCY_KEY_REUSED'],
  ])('%s → nothing was written: the next try is a new key', async (_label, status, code) => {
    mocks.request.mockRejectedValueOnce(answer(status, code)).mockResolvedValueOnce(created);
    await expect(useBook()).rejects.toBeTruthy();
    await useBook();
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it('a 5xx that reuses a refusal code is still kept (the status decides first)', async () => {
    mocks.request.mockRejectedValueOnce(answer(500, 'NO_DRIVERS_NEARBY')).mockResolvedValueOnce(created);
    await expect(useBook()).rejects.toBeTruthy();
    await useBook();
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('a created ride spends the key', async () => {
    mocks.request.mockResolvedValue(created);
    await useBook();
    await useBook();
    expect(keyOf(1)).not.toBe(keyOf(0));
  });
});

describe('concurrent identical requests', () => {
  it('[review 3.1] two taps in flight at once share one key', async () => {
    const releases: Array<(v: unknown) => void> = [];
    mocks.request.mockImplementation(() => new Promise((resolve) => { releases.push(resolve); }));
    const first = useBook();
    const second = useBook();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(keyOf(0));
    for (const release of releases) release(created);
    await Promise.allSettled([first, second]);
  });
});
