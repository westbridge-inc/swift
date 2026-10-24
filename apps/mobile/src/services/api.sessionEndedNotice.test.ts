import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import type { User } from '@swift/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// [Row 3 · "You were signed out"] Through the REAL API client and the REAL
// auth store: when the server ends this phone's session, the app signs out AND
// says so, once, with a way straight back to sign-in. A blip (offline, a 5xx)
// signs nobody out and says nothing; a person's own sign-out says nothing.
// Synthetic accounts and tokens only; only native drawing and transport are fakes.

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('react-native', () => ({ TurboModuleRegistry: { get: () => null }, Alert: { alert }, Linking: { openURL: vi.fn(() => Promise.resolve()) } }));
vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../lib/storage', () => ({ zustandStorage: { getItem: () => null, setItem() {}, removeItem() {} } }));
vi.mock('../lib/adsQueue', () => ({ retireAdEventScope() {} }));
vi.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `signed-out-fixture-${++next}` }; });
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('../services/push', () => ({ preparePushTokenForLogout: async () => null }));
vi.mock('../services/backgroundLocation', () => ({ stopMoverLocation: async () => {} }));
vi.mock('../services/socket', () => ({ disconnectSocket() {} }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ setSelectedStore() {}, selectedStoreId: null }) } }));

import { useAuthStore } from '../stores/authStore';
import { api } from './api';
import { SIGNED_OUT_MESSAGE } from '../lib/sessionEndedNotice';

const originalAxiosAdapter = axios.defaults.adapter;
const originalApiAdapter = api.defaults.adapter;
const response = (config: InternalAxiosRequestConfig, status: number, data: unknown) => ({ config, status, statusText: '', headers: {}, data });
const reject = (config: InternalAxiosRequestConfig, status: number, data: unknown = {}) => {
  throw new AxiosError('fixture rejection', 'ERR_BAD_RESPONSE', config, undefined, response(config, status, data));
};
const login = (id: string) => useAuthStore.getState().setAuth(
  { id, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', firstName: 'Fixture' } as User,
  `synthetic-access-${id}`, `synthetic-refresh-${id}`,
);
const notices = () => alert.mock.calls.filter((c) => c[1] === SIGNED_OUT_MESSAGE);
const transport = (adapter: (config: InternalAxiosRequestConfig) => Promise<unknown>) => {
  axios.defaults.adapter = adapter as never;
  api.defaults.adapter = adapter as never;
};

beforeEach(() => {
  alert.mockClear();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false, wantsAuth: false });
  login('a');
});
afterEach(async () => {
  await vi.dynamicImportSettled();
  axios.defaults.adapter = originalAxiosAdapter;
  api.defaults.adapter = originalApiAdapter;
});

describe('the server ended the session', () => {
  it('a refused refresh signs out and says so once, even with two requests in flight; "Sign in" opens sign-in', async () => {
    transport(async (config) => {
      if (config.url?.endsWith('/auth/logout/refresh')) return response(config, 200, {});
      if (config.url?.endsWith('/auth/refresh')) return reject(config, 401, { error: { code: 'INVALID_TOKEN', message: 'Invalid or expired refresh token' } });
      return reject(config, 401);
    });
    await Promise.all([
      expect(api.get('/customer/profile')).rejects.toBeInstanceOf(AxiosError),
      expect(api.get('/customer/orders')).rejects.toBeInstanceOf(AxiosError),
    ]);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(notices()).toHaveLength(1);
    const buttons = notices()[0]![2] as Array<{ text: string; onPress?: () => void }>;
    expect(useAuthStore.getState().wantsAuth).toBe(false);
    buttons.find((b) => b.text === 'Sign in')?.onPress?.();
    expect(useAuthStore.getState().wantsAuth).toBe(true);
  });

  it('a refreshed credential the server then rejects (the replay) signs out and says so', async () => {
    let reads = 0;
    transport(async (config) => {
      if (config.url?.endsWith('/auth/logout/refresh')) return response(config, 200, {});
      if (config.url?.endsWith('/auth/refresh')) return response(config, 200, { data: { accessToken: 'synthetic-rotated', refreshToken: 'synthetic-rotated' } });
      reads++;
      return reject(config, 401);
    });
    await expect(api.get('/customer/profile')).rejects.toBeInstanceOf(AxiosError);
    expect(reads).toBe(2);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(notices()).toHaveLength(1);
  });

  it('a suspended account gets its own explanation, not the generic one', async () => {
    transport(async (config) => {
      if (config.url?.endsWith('/auth/logout/refresh')) return response(config, 200, {});
      if (config.url?.endsWith('/auth/refresh')) return reject(config, 403, { error: {
        code: 'ACCOUNT_SUSPENDED', message: 'Your Swift account is suspended, so it can’t sign in right now.',
        details: { accountStatus: 'SUSPENDED', supportEmail: 'support@swiftgy.com' },
      } });
      return reject(config, 401);
    });
    await expect(api.get('/customer/profile')).rejects.toBeInstanceOf(AxiosError);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0]![1]).toMatch(/suspended/i);
    expect(notices()).toHaveLength(0);
  });
});

describe('nothing to say', () => {
  it.each([
    ['offline', (config: InternalAxiosRequestConfig) => { throw new AxiosError('unavailable', 'ERR_NETWORK', config); }],
    ['a server error', (config: InternalAxiosRequestConfig) => reject(config, 503)],
  ])('a refresh that fails because %s keeps the session and stays quiet', async (_why, refresh) => {
    transport(async (config) => {
      if (config.url?.endsWith('/auth/refresh')) return refresh(config);
      return reject(config, 401);
    });
    await expect(api.get('/customer/profile')).rejects.toBeInstanceOf(AxiosError);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(alert).not.toHaveBeenCalled();
  });

  it('a person’s own sign-out is not announced', async () => {
    transport(async (config) => response(config, 200, {}));
    useAuthStore.getState().logout();
    await vi.dynamicImportSettled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});
