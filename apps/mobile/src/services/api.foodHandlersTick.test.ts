import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

// [REVIEW-F #2062 S4-1] The food handlers tick is for ONE store: the request names that store itself (x-vendor-id =
// the ticked store), so an owner of several restaurants who ticks "Second Kitchen" never ticks whichever store happens
// to be selected in the switcher (the interceptor only fills the header when the request names none).

const env = vi.hoisted(() => {
  const previousApiUrl = process.env['EXPO_PUBLIC_API_URL'];
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  return { previousApiUrl };
});

const auth = vi.hoisted(() => ({
  current: null as AuthSessionSnapshot | null,
  selectedStoreId: null as string | null,
}));

vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => auth.current,
  isAuthSessionSnapshotCurrent: () => false,
  useAuthStore: { getState: () => ({ rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }) },
}));
vi.mock('../stores/storeSwitcher', () => ({
  useStoreSwitcher: { getState: () => ({ selectedStoreId: auth.selectedStoreId }) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } }));

import { api, vendorApi } from './api';

const originalApiAdapter = api.defaults.adapter;

function ok(config: InternalAxiosRequestConfig): AxiosResponse {
  return { config, status: 201, statusText: 'Created', headers: {}, data: { success: true, data: { foodHandlers: { attested: true } } } };
}

afterEach(() => {
  api.defaults.adapter = originalApiAdapter;
  auth.current = null;
  auth.selectedStoreId = null;
});

afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

describe('[FOOD-PERMIT] the food handlers tick names its own store', () => {
  it('sends x-vendor-id = the ticked store, not the store selected in the switcher', async () => {
    auth.current = { generation: 1, userId: 'owner-a', accessToken: 'access-a', refreshToken: 'refresh-a' };
    auth.selectedStoreId = 'store-selected';
    const seen: InternalAxiosRequestConfig[] = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push(config);
      return ok(config);
    };
    api.defaults.adapter = adapter;

    await vendorApi.tickFoodHandlers('store-ticked', 'v1');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('/vendor/onboarding/food-handlers');
    expect(seen[0]!.headers.get('x-vendor-id')).toBe('store-ticked');
    const body = typeof seen[0]!.data === 'string' ? JSON.parse(seen[0]!.data) : seen[0]!.data;
    expect(body).toEqual({ accept: true, attestationVersion: 'v1' });
  });
});
