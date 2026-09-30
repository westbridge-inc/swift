import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

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
vi.mock('react-native', () => ({ TurboModuleRegistry: { get: () => null } }));

import { api, riderApi, vendorApi } from './api';

const originalApiAdapter = api.defaults.adapter;
const accountA: AuthSessionSnapshot = {
  generation: 1,
  userId: 'account-a',
  accessToken: 'access-a',
  refreshToken: 'refresh-a',
};

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
  auth.current = null;
  auth.selectedStoreId = null;
});

afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

describe('delivery cash-settlement attestation requests', () => {
  it.each([
    ['rider', riderApi.confirmCashSettlement, '/rider/cash-settlements/settlement-1/confirm'],
    ['vendor', vendorApi.confirmCashSettlement, '/vendor/cash-settlements/settlement-1/confirm'],
  ] as const)('%s sends the authoritative row amount in the exact request body', async (_side, confirm, url) => {
    const seen: InternalAxiosRequestConfig[] = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push(config);
      return response(config, 200, { success: true, data: { status: 'SETTLED' } });
    };
    api.defaults.adapter = adapter;

    await confirm('settlement-1', 417.25, accountA);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(url);
    expect(seen[0]!.method).toBe('post');
    expect(jsonBody(seen[0]!)).toStrictEqual({ amount: 417.25 });
    expect(seen[0]!.headers.get('Authorization')).toBe('Bearer access-a');
  });

  it.each([
    ['rider', riderApi.confirmCashSettlement],
    ['vendor', vendorApi.confirmCashSettlement],
  ] as const)('%s preserves the server amount-mismatch refusal', async (_side, confirm) => {
    api.defaults.adapter = (async (config) => {
      const result = response(config, 409, {
        error: {
          code: 'ATTESTED_AMOUNT_MISMATCH',
          message: 'This settlement amount does not match.',
        },
      });
      throw new AxiosError(
        'Request failed with status code 409',
        AxiosError.ERR_BAD_REQUEST,
        config,
        undefined,
        result,
      );
    }) as AxiosAdapter;

    await expect(confirm('settlement-1', 418, accountA)).rejects.toMatchObject({
      response: {
        status: 409,
        data: { error: { code: 'ATTESTED_AMOUNT_MISMATCH' } },
      },
    });
  });

  it('pins the originating vendor store instead of a later selection', async () => {
    const seen: InternalAxiosRequestConfig[] = [];
    api.defaults.adapter = (async (config) => {
      seen.push(config);
      return response(config, 200, { success: true, data: { status: 'STORE_CONFIRMED' } });
    }) as AxiosAdapter;
    auth.selectedStoreId = 'store-b';

    await vendorApi.confirmCashSettlement('settlement-1', 417.25, accountA, 'store-a');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get('x-vendor-id')).toBe('store-a');
    expect(seen[0]!.headers.get('Authorization')).toBe('Bearer access-a');
  });
});
