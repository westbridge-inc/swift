import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import type { User } from '@swift/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../lib/storage', () => ({ zustandStorage: { getItem: () => null, setItem() {}, removeItem() {} } }));
vi.mock('../lib/adsQueue', () => ({ retireAdEventScope() {} }));
vi.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `replay-fixture-${++next}` }; });
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ TurboModuleRegistry: { get: () => null } }));
vi.mock('../services/push', () => ({ preparePushTokenForLogout: async () => null }));
vi.mock('../services/backgroundLocation', () => ({ stopMoverLocation: async () => {} }));
vi.mock('../services/socket', () => ({ disconnectSocket() {} }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ setSelectedStore() {}, selectedStoreId: null }) } }));

import '../services/backgroundLocation';
import '../services/socket';
import '../services/push';
import { bindQueryCacheScope } from '../lib/appQueryPolicy';
import { queryClient } from '../lib/queryClient';
import { getAuthSessionSnapshot, useAuthStore } from '../stores/authStore';
import { api } from './api';

const originalAxiosAdapter = axios.defaults.adapter;
const originalApiAdapter = api.defaults.adapter;
const key = ['customer', 'profile'];
const login = (id: string) => useAuthStore.getState().setAuth(
  { id, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', firstName: 'Fixture' } as User,
  `synthetic-access-${id}`, `synthetic-refresh-${id}`,
);
const response = (config: InternalAxiosRequestConfig, status: number, data: unknown) => ({ config, status, statusText: '', headers: {}, data });
let stop: () => void;
beforeEach(() => {
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false });
  stop = bindQueryCacheScope(queryClient, useAuthStore);
  login('a');
  queryClient.setQueryData(key, { owner: 'a' });
});
afterEach(async () => {
  await vi.dynamicImportSettled();
  stop(); queryClient.clear();
  axios.defaults.adapter = originalAxiosAdapter;
  api.defaults.adapter = originalApiAdapter;
});

describe('F4: authoritative replay rejection through real authStore', () => {
  it.each(['current', 'replacement', 'new-rotation', 'network', 'timeout', 'server'] as const)(
    'replay failure preserves only the eligible session/cache (%s)', async (scenario) => {
      let reads = 0;
      let refreshes = 0;
      const adapter = async (config: InternalAxiosRequestConfig) => {
        if (config.url?.endsWith('/auth/refresh')) {
          refreshes++;
          return response(config, 200, { data: { accessToken: 'synthetic-rotated', refreshToken: 'synthetic-rotated' } });
        }
        if (config.url?.endsWith('/auth/logout/refresh')) return response(config, 200, {});
        reads++;
        if (reads === 2) {
          if (scenario === 'replacement') {
            login('b');
            queryClient.setQueryData(key, { owner: 'b' });
            // Finish A's mocked native teardown before delivering its late
            // replay rejection. B is already installed with its own cache.
            await vi.dynamicImportSettled();
          }
          if (scenario === 'new-rotation') {
            useAuthStore.getState().rotateTokensIfCurrent(getAuthSessionSnapshot()!, {
              accessToken: 'synthetic-newer', refreshToken: 'synthetic-newer',
            });
          }
          if (scenario === 'network' || scenario === 'timeout') {
            throw new AxiosError('unavailable', scenario === 'timeout' ? 'ECONNABORTED' : 'ERR_NETWORK', config);
          }
        }
        const status = reads === 2 && scenario === 'server' ? 503 : 401;
        throw new AxiosError('fixture rejection', 'ERR_BAD_RESPONSE', config, undefined, response(config, status, {}));
      };
      axios.defaults.adapter = adapter;
      api.defaults.adapter = adapter;
      await expect(api.get('/customer/profile')).rejects.toBeInstanceOf(AxiosError);
      await vi.dynamicImportSettled();
      expect(reads).toBe(2);
      expect(refreshes).toBe(1);
      if (scenario === 'current') {
        expect(useAuthStore.getState().isAuthenticated).toBe(false);
        expect(getAuthSessionSnapshot()).toBeNull();
        expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
      } else {
        expect(useAuthStore.getState().isAuthenticated).toBe(true);
        expect(queryClient.getQueryData(key)).toEqual({ owner: scenario === 'replacement' ? 'b' : 'a' });
        if (scenario === 'new-rotation') expect(getAuthSessionSnapshot()?.accessToken).toBe('synthetic-newer');
      }
    },
  );
});
