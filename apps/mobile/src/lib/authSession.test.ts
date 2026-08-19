import { describe, expect, it, vi } from 'vitest';
import {
  AuthRefreshCoordinator,
  authSessionForPrincipal,
  sameAuthSession,
  samePrincipalBoundary,
  type AuthSessionSnapshot,
  type RotatedAuthTokens,
} from './authSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const a: AuthSessionSnapshot = {
  generation: 1,
  userId: 'user-a',
  accessToken: 'access-a-1',
  refreshToken: 'refresh-a-1',
};

const b: AuthSessionSnapshot = {
  generation: 3,
  userId: 'user-b',
  accessToken: 'access-b-1',
  refreshToken: 'refresh-b-1',
};

function harness(
  refresh: (token: string) => Promise<RotatedAuthTokens>,
  shouldLogoutAfterRefreshFailure: (error: unknown) => boolean = () => false,
) {
  let current: AuthSessionSnapshot | null = { ...a };
  const logoutIfCurrent = vi.fn((expected: AuthSessionSnapshot) => {
    if (!sameAuthSession(current, expected)) return false;
    current = null;
    return true;
  });
  const rotateTokensIfCurrent = vi.fn((expected: AuthSessionSnapshot, tokens: RotatedAuthTokens) => {
    if (!sameAuthSession(current, expected)) return null;
    current = { ...current!, ...tokens };
    return current;
  });
  const coordinator = new AuthRefreshCoordinator(
    { current: () => current, rotateTokensIfCurrent, logoutIfCurrent },
    refresh,
    shouldLogoutAfterRefreshFailure,
  );
  return {
    coordinator,
    current: () => current,
    setCurrent: (value: AuthSessionSnapshot | null) => {
      current = value;
    },
    logoutIfCurrent,
    rotateTokensIfCurrent,
  };
}

describe('AuthRefreshCoordinator', () => {
  it('single-flights matching 401s and gives both callers the rotated access token', async () => {
    const pending = deferred<RotatedAuthTokens>();
    const refresh = vi.fn(() => pending.promise);
    const h = harness(refresh);

    const first = h.coordinator.resolve({ ...a });
    const second = h.coordinator.resolve({ ...a });
    expect(refresh).toHaveBeenCalledOnce();

    pending.resolve({ accessToken: 'access-a-2', refreshToken: 'refresh-a-2' });
    await expect(first).resolves.toMatchObject({ accessToken: 'access-a-2' });
    await expect(second).resolves.toMatchObject({ accessToken: 'access-a-2' });
    expect(h.rotateTokensIfCurrent).toHaveBeenCalledOnce();
  });

  it('cannot resurrect a session that logged out while refresh was pending', async () => {
    const pending = deferred<RotatedAuthTokens>();
    const h = harness(() => pending.promise);
    const result = h.coordinator.resolve({ ...a });

    h.setCurrent(null);
    pending.resolve({ accessToken: 'stale-access-a', refreshToken: 'stale-refresh-a' });

    await expect(result).resolves.toBeNull();
    expect(h.current()).toBeNull();
  });

  it('cannot attach A tokens to B when B logs in before A refresh resolves', async () => {
    const pending = deferred<RotatedAuthTokens>();
    const h = harness(() => pending.promise);
    const result = h.coordinator.resolve({ ...a });

    h.setCurrent({ ...b });
    pending.resolve({ accessToken: 'stale-access-a', refreshToken: 'stale-refresh-a' });

    await expect(result).resolves.toBeNull();
    expect(h.current()).toEqual(b);
  });

  it('does not log B out when A refresh later fails', async () => {
    const pending = deferred<RotatedAuthTokens>();
    const h = harness(() => pending.promise, () => true);
    const result = h.coordinator.resolve({ ...a });

    h.setCurrent({ ...b });
    pending.reject(new Error('A refresh rejected'));

    await expect(result).resolves.toBeNull();
    expect(h.current()).toEqual(b);
    expect(h.logoutIfCurrent).toHaveReturnedWith(false);
  });

  it('starts an independent B flight while stale A is still pending', async () => {
    const aPending = deferred<RotatedAuthTokens>();
    const bPending = deferred<RotatedAuthTokens>();
    const refresh = vi.fn((token: string) => (token === a.refreshToken ? aPending.promise : bPending.promise));
    const h = harness(refresh);

    const aResult = h.coordinator.resolve({ ...a });
    h.setCurrent({ ...b });
    const bResult = h.coordinator.resolve({ ...b });
    expect(refresh).toHaveBeenCalledTimes(2);

    aPending.resolve({ accessToken: 'stale-access-a', refreshToken: 'stale-refresh-a' });
    await expect(aResult).resolves.toBeNull();
    expect(h.current()).toEqual(b);

    bPending.resolve({ accessToken: 'access-b-2', refreshToken: 'refresh-b-2' });
    await expect(bResult).resolves.toMatchObject({ accessToken: 'access-b-2' });
    expect(h.current()).toMatchObject({ userId: b.userId, accessToken: 'access-b-2' });
  });

  it('reuses a completed sibling rotation for a late 401 without another refresh POST', async () => {
    const refresh = vi.fn(async () => ({ accessToken: 'access-a-2', refreshToken: 'refresh-a-2' }));
    const h = harness(refresh);
    await h.coordinator.resolve({ ...a });

    const late = await h.coordinator.resolve({ ...a });
    expect(late).toMatchObject({ accessToken: 'access-a-2' });
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('auth session identity', () => {
  it('distinguishes token rotation from a principal boundary', () => {
    const rotated = { ...a, accessToken: 'a2', refreshToken: 'r2' };
    expect(samePrincipalBoundary(a, rotated)).toBe(true);
    expect(sameAuthSession(a, rotated)).toBe(false);
    expect(samePrincipalBoundary(a, b)).toBe(false);
  });

  it('gives a runtime fresh rotated credentials only inside its principal boundary', () => {
    const owner = { generation: a.generation, userId: a.userId };
    const rotated = { ...a, accessToken: 'access-a-2', refreshToken: 'refresh-a-2' };
    expect(authSessionForPrincipal(rotated, owner)).toBe(rotated);
    expect(authSessionForPrincipal(b, owner)).toBeNull();
    expect(authSessionForPrincipal(null, owner)).toBeNull();
  });
});
