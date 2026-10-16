import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import type { User } from '@swift/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// [Row 353 · DL-9] The store-review demo answers 410 REVIEW_SESSION_CLOSED once
// its session is over. Through the REAL API client and the REAL auth store: the
// demo session is signed out once, the person is told why, the server session
// is revoked, and nothing is refreshed or retried. Any other 410, and a demo
// answer that arrives after another account signed in, change nothing.
// Synthetic accounts and tokens only; native drawing and transport are fakes.

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('react-native', () => ({ TurboModuleRegistry: { get: () => null }, Alert: { alert }, Linking: { openURL: vi.fn(() => Promise.resolve()) } }));
vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../lib/storage', () => ({ zustandStorage: { getItem: () => null, setItem() {}, removeItem() {} } }));
vi.mock('../lib/adsQueue', () => ({ retireAdEventScope() {} }));
vi.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `demo-closed-fixture-${++next}` }; });
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('../services/push', () => ({ preparePushTokenForLogout: async () => null }));
vi.mock('../services/backgroundLocation', () => ({ stopMoverLocation: async () => {} }));
vi.mock('../services/socket', () => ({ disconnectSocket() {} }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ setSelectedStore() {}, selectedStoreId: null }) } }));

import { getAuthSessionSnapshot, useAuthStore } from '../stores/authStore';
import { api } from './api';
import { DEMO_ENDED_MESSAGE, DEMO_ENDED_TITLE, isReviewSessionClosed } from '../lib/reviewSessionClosed';

const originalAxiosAdapter = axios.defaults.adapter;
const originalApiAdapter = api.defaults.adapter;
const response = (config: InternalAxiosRequestConfig, status: number, data: unknown) => ({ config, status, statusText: '', headers: {}, data });
const closed = { success: false, error: { code: 'REVIEW_SESSION_CLOSED', message: 'This demo has ended, so its sample stores and orders are no longer available.' } };
const login = (id: string) => useAuthStore.getState().setAuth(
  { id, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', firstName: 'Fixture' } as User,
  `synthetic-access-${id}`, `synthetic-refresh-${id}`,
);
let seen: string[] = [];
const transport = (answer: (config: InternalAxiosRequestConfig) => Promise<unknown>) => {
  const adapter = async (config: InternalAxiosRequestConfig) => { seen.push(String(config.url)); return answer(config); };
  axios.defaults.adapter = adapter as never;
  api.defaults.adapter = adapter as never;
};
const demoNotices = () => alert.mock.calls.filter((c) => c[0] === DEMO_ENDED_TITLE);

beforeEach(() => {
  alert.mockClear();
  seen = [];
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false, wantsAuth: false });
  login('demo');
});
afterEach(async () => {
  await vi.dynamicImportSettled();
  axios.defaults.adapter = originalAxiosAdapter;
  api.defaults.adapter = originalApiAdapter;
});

describe('the demo session is over', () => {
  it('signs the demo account out once and says why, even with two requests in flight; no refresh, no retry', async () => {
    transport(async (config) => {
      if (config.url?.endsWith('/auth/logout/refresh')) return response(config, 200, {});
      throw new AxiosError('gone', 'ERR_BAD_REQUEST', config, undefined, response(config, 410, closed));
    });
    const results = await Promise.allSettled([api.get('/auth/me'), api.get('/customer/home')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(results.map((r) => (r as PromiseRejectedResult).reason?.response?.status)).toEqual([410, 410]);
    await vi.dynamicImportSettled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(getAuthSessionSnapshot()).toBeNull();
    expect(demoNotices()).toHaveLength(1);
    expect(demoNotices()[0]![1]).toBe(DEMO_ENDED_MESSAGE);
    // The server session is revoked with the demo's own refresh credential; nothing refreshes and nothing is retried.
    expect(seen.filter((u) => u.endsWith('/auth/refresh'))).toEqual([]);
    expect(seen.filter((u) => u.endsWith('/auth/logout/refresh'))).toHaveLength(1);
    expect(seen.filter((u) => u === '/auth/me' || u === '/customer/home')).toHaveLength(2);
  });

  it('a demo answer that lands after another account signed in leaves that account alone', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    transport(async (config) => {
      if (config.url?.endsWith('/auth/logout/refresh')) return response(config, 200, {});
      await gate;
      throw new AxiosError('gone', 'ERR_BAD_REQUEST', config, undefined, response(config, 410, closed));
    });
    const pending = api.get('/auth/me').catch((e: unknown) => e);
    login('someone-else');
    release();
    await pending;
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().user?.id).toBe('someone-else');
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('nothing else is a closed demo', () => {
  it.each([
    ['another 410', { success: false, error: { code: 'GONE', message: 'That item is gone.' } }],
    ['a 410 with no body', undefined],
  ])('%s keeps the session and says nothing', async (_why, body) => {
    transport(async (config) => { throw new AxiosError('gone', 'ERR_BAD_REQUEST', config, undefined, response(config, 410, body)); });
    await expect(api.get('/customer/home')).rejects.toBeInstanceOf(AxiosError);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(alert).not.toHaveBeenCalled();
  });

  it('only a 410 that names REVIEW_SESSION_CLOSED counts', () => {
    expect(isReviewSessionClosed({ response: { status: 410, data: closed } })).toBe(true);
    expect(isReviewSessionClosed({ response: { status: 403, data: closed } })).toBe(false);
    expect(isReviewSessionClosed({ response: { status: 410, data: { error: { code: 'GONE' } } } })).toBe(false);
    expect(isReviewSessionClosed(new Error('Network Error'))).toBe(false);
    expect(isReviewSessionClosed(null)).toBe(false);
  });
});
