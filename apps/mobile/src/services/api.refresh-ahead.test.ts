import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import type { User } from '@swift/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// [PERF #9] The early refresh is the app's ONE refresh: it shares the 401
// path's single flight, rotates only the exact session that asked, and a
// request that meets a 401 meanwhile rides the same refresh (never a second
// one, never a replayed refresh token). Synthetic accounts and tokens only.

vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../lib/storage', () => ({ zustandStorage: { getItem: () => null, setItem() {}, removeItem() {} } }));
vi.mock('../lib/adsQueue', () => ({ retireAdEventScope() {} }));
vi.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `refresh-ahead-fixture-${++next}` }; });
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ TurboModuleRegistry: { get: () => null } }));
vi.mock('../services/push', () => ({ preparePushTokenForLogout: async () => null }));
vi.mock('../services/backgroundLocation', () => ({ stopMoverLocation: async () => {} }));
vi.mock('../services/socket', () => ({ disconnectSocket() {} }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ setSelectedStore() {}, selectedStoreId: null }) } }));

import { getAuthSessionSnapshot, useAuthStore } from '../stores/authStore';
import { api, refreshSessionAhead } from './api';

const originalAxiosAdapter = axios.defaults.adapter;
const originalApiAdapter = api.defaults.adapter;
const response = (config: InternalAxiosRequestConfig, status: number, data: unknown) => ({ config, status, statusText: '', headers: {}, data });
const login = (id: string) => useAuthStore.getState().setAuth(
  { id, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', firstName: 'Fixture' } as User,
  `synthetic-access-${id}`, `synthetic-refresh-${id}`,
);

beforeEach(() => {
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false });
  login('a');
});
afterEach(async () => {
  await vi.dynamicImportSettled();
  axios.defaults.adapter = originalAxiosAdapter;
  api.defaults.adapter = originalApiAdapter;
});

describe('refreshSessionAhead shares the app’s one refresh (PERF #9)', () => {
  it('a request that meets a 401 during an early refresh rides that refresh: one refresh call, the request retried with the new token', async () => {
    const refreshBodies: unknown[] = [];
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const seenAuth: string[] = [];
    const adapter = async (config: InternalAxiosRequestConfig) => {
      if (config.url?.endsWith('/auth/refresh')) {
        refreshBodies.push(JSON.parse(String(config.data)));
        await refreshGate;
        return response(config, 200, { data: { accessToken: 'synthetic-access-rotated', refreshToken: 'synthetic-refresh-rotated' } });
      }
      const auth = String(config.headers?.['Authorization'] ?? '');
      seenAuth.push(auth);
      if (auth === 'Bearer synthetic-access-a') {
        throw new AxiosError('lapsed', 'ERR_BAD_REQUEST', config, undefined, response(config, 401, {}));
      }
      return response(config, 200, { success: true, data: { ok: true } });
    };
    axios.defaults.adapter = adapter;
    api.defaults.adapter = adapter;

    const early = refreshSessionAhead(getAuthSessionSnapshot()!);
    const read = api.get('/customer/profile');
    await vi.waitFor(() => expect(seenAuth).toEqual(['Bearer synthetic-access-a']));
    releaseRefresh();
    const [outcome, answer] = await Promise.all([early, read]);

    expect(refreshBodies).toEqual([{ refreshToken: 'synthetic-refresh-a' }]);
    expect(outcome?.accessToken).toBe('synthetic-access-rotated');
    expect(answer.data).toEqual({ success: true, data: { ok: true } });
    expect(seenAuth).toEqual(['Bearer synthetic-access-a', 'Bearer synthetic-access-rotated']);
    expect(getAuthSessionSnapshot()?.refreshToken).toBe('synthetic-refresh-rotated');
  });

  it('an early refresh for a session that has since signed out or switched account changes nothing', async () => {
    let refreshes = 0;
    const adapter = async (config: InternalAxiosRequestConfig) => {
      if (config.url?.endsWith('/auth/refresh')) refreshes++;
      return response(config, 200, { data: { accessToken: 'synthetic-access-rotated', refreshToken: 'synthetic-refresh-rotated' } });
    };
    axios.defaults.adapter = adapter;
    api.defaults.adapter = adapter;

    const stale = getAuthSessionSnapshot()!;
    login('b');
    expect(await refreshSessionAhead(stale)).toBeNull();
    expect(refreshes).toBe(0);
    expect(getAuthSessionSnapshot()?.accessToken).toBe('synthetic-access-b');
  });
});
