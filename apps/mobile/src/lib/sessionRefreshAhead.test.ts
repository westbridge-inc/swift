import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from './authSession';
import {
  REFRESH_AHEAD_MIN_GAP_MS,
  REFRESH_AHEAD_MS,
  accessTokenExpiresAt,
  keepSessionFresh,
} from './sessionRefreshAhead';

// [PERF #9] The first request after the 15-minute access token lapsed paid a
// 401, a refresh and a retry. While the app is on screen the session is now
// refreshed just before the token lapses (and at once on coming back to the
// screen with a lapsed one), through the app's one refresh. Synthetic tokens.

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const b64url = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A JWT-shaped synthetic token (unsigned: only its timing is ever read). */
const token = (expiresAt: number, tag = 'a') => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ userId: 'fixture', tag, exp: Math.floor(expiresAt / 1000) })}.sig`;

let session: AuthSessionSnapshot | null;
let active: boolean;
const appListeners = new Set<() => void>();
const sessionListeners = new Set<() => void>();
const refresh = vi.fn<(s: AuthSessionSnapshot) => Promise<unknown>>();
let stop: (() => void) | undefined;

const signIn = (expiresAt: number, tag = 'a') => { session = { userId: 'fixture', generation: 1, accessToken: token(expiresAt, tag), refreshToken: `refresh-${tag}` }; };
/** The server answers the refresh with a new 15-minute token (rotation). */
const rotates = (tag: string) => refresh.mockImplementationOnce(async () => {
  signIn(Date.now() + 15 * MIN, tag);
  sessionListeners.forEach((listener) => listener());
  return {};
});
const setActive = (value: boolean) => { active = value; appListeners.forEach((listener) => listener()); };
const start = () => {
  stop = keepSessionFresh({
    current: () => session,
    refresh,
    isActive: () => active,
    onAppStateChange: (listener) => { appListeners.add(listener); return () => appListeners.delete(listener); },
    onSessionChange: (listener) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  refresh.mockReset();
  refresh.mockResolvedValue(null);
  appListeners.clear(); sessionListeners.clear();
  session = null;
  active = true;
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });

describe('accessTokenExpiresAt', () => {
  it('reads the exp claim of a JWT-shaped token, base64url and unpadded', () => {
    expect(accessTokenExpiresAt(token(T0 + 15 * MIN))).toBe(T0 + 15 * MIN);
  });
  it.each(['', 'opaque-token', 'a.!!!.c', `x.${b64url({ exp: 'soon' })}.y`, `x.${b64url({ sub: 'no-exp' })}.y`])('returns null for %j', (value) => {
    expect(accessTokenExpiresAt(value)).toBeNull();
  });
});

describe('keepSessionFresh (PERF #9)', () => {
  it('refreshes one minute before the token lapses while the app is on screen, then again for the next token', async () => {
    signIn(T0 + 15 * MIN);
    start();
    await vi.advanceTimersByTimeAsync(14 * MIN - 1_000);
    expect(refresh).not.toHaveBeenCalled();
    rotates('b');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]![0].refreshToken).toBe('refresh-a');
    // The new token is refreshed a minute before IT lapses.
    rotates('c');
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[1]![0].refreshToken).toBe('refresh-b');
  });

  it('refreshes at once on coming back to the screen with a lapsed token', async () => {
    signIn(T0 + 15 * MIN);
    start();
    setActive(false);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(refresh).not.toHaveBeenCalled();
    setActive(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the app is in the background, or with a fresh token on coming back', async () => {
    signIn(T0 + 15 * MIN);
    active = false;
    start();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(refresh).not.toHaveBeenCalled();
    signIn(Date.now() + 15 * MIN, 'fresh');
    setActive(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does nothing when signed out, or for a token with no readable expiry (the 401 path covers it)', async () => {
    start();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    session = { userId: 'fixture', generation: 1, accessToken: 'opaque-token', refreshToken: 'refresh-x' };
    sessionListeners.forEach((listener) => listener());
    setActive(false); setActive(true);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a phone clock far ahead of the server never turns it into a loop: at most one early refresh per 10 minutes', async () => {
    // Every token the server issues already looks lapsed by this phone's clock.
    signIn(T0 - 20 * MIN);
    refresh.mockImplementation(async () => {
      // (A runaway loop stops answering here, so it fails the count below instead of hanging.)
      if (refresh.mock.calls.length > 5) return new Promise(() => {});
      signIn(Date.now() - 20 * MIN, `skewed-${refresh.mock.calls.length}`);
      sessionListeners.forEach((listener) => listener());
      return {};
    });
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_AHEAD_MIN_GAP_MS - 1_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('a refresh that fails (offline) leaves the token to the 401 path and is tried again no sooner than 10 minutes later', async () => {
    signIn(T0 + 30_000);
    refresh.mockImplementation(async () => {
      // (A runaway retry loop stops answering here, so it fails the count below instead of hanging.)
      if (refresh.mock.calls.length > 5) return new Promise(() => {});
      throw new Error('offline');
    });
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_AHEAD_MIN_GAP_MS - 1_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('stops cleanly: no timer, no listener', async () => {
    signIn(T0 + 15 * MIN);
    start();
    stop!();
    stop = undefined;
    expect(appListeners.size + sessionListeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(refresh).not.toHaveBeenCalled();
    expect(REFRESH_AHEAD_MS).toBe(MIN);
  });
});

describe('the app keeps the session fresh from its root (PERF #9)', () => {
  it('App.tsx mounts the early refresh with the app’s one refresh, the real app state and the real session', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
    expect(app).toContain('<SessionRefreshAhead />');
    expect(app).toMatch(/keepSessionFresh\(\{\s*current: getAuthSessionSnapshot,\s*refresh: refreshSessionAhead,\s*isActive: \(\) => AppState\.currentState === 'active',/);
    expect(app).toMatch(/AppState\.addEventListener\('change', listener\)/);
    expect(app).toMatch(/useAuthStore\.subscribe\(\(state, previous\) => \{\s*if \(state\.accessToken !== previous\.accessToken\) listener\(\);/);
  });
});
