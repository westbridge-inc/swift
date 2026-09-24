import {
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  const previousApiUrl = process.env['EXPO_PUBLIC_API_URL'];
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  return { previousApiUrl };
});

vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => null,
  isAuthSessionSnapshotCurrent: () => false,
  useAuthStore: { getState: () => ({ rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }) },
}));
vi.mock('../stores/storeSwitcher', () => ({
  useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ TurboModuleRegistry: { get: () => null } }));

import { api, driverApi, riderApi, vendorApi } from './api';

const originalApiAdapter = api.defaults.adapter;

function response(
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown,
): AxiosResponse {
  return { config, status, statusText: status === 200 ? 'OK' : 'Conflict', headers: {}, data };
}

function jsonBody(config: InternalAxiosRequestConfig): unknown {
  return typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
}

afterEach(() => {
  api.defaults.adapter = originalApiAdapter;
});

afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

describe('E12 — billing-method stop/resume requests', () => {
  it.each([
    ['rider', riderApi.setBillingMethod, '/rider/subscription/billing-method'],
    ['driver', driverApi.setBillingMethod, '/driver/subscription/billing-method'],
    ['vendor', vendorApi.setBillingMethod, '/vendor/subscription/billing-method'],
  ] as const)('%s sends the exact stop and resume bodies', async (_side, set, url) => {
    const seen: InternalAxiosRequestConfig[] = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push(config);
      return response(config, 200, { success: true, data: { billingMethod: 'CASH', mmgPayerMsisdn: null } });
    };
    api.defaults.adapter = adapter;

    await set('NONE');
    await set('CASH');
    await set('MOBILE_MONEY', '6099999');

    expect(seen.map((c) => c.url)).toEqual([url, url, url]);
    expect(seen.map((c) => c.method)).toEqual(['put', 'put', 'put']);
    expect(seen.map((c) => jsonBody(c))).toEqual([
      { method: 'NONE' },
      { method: 'CASH' },
      { method: 'MOBILE_MONEY', mmgPayerMsisdn: '6099999' },
    ]);
  });
});
