import {
  AxiosError,
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

import { api, riderApi, vendorApi } from './api';

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

    await confirm('settlement-1', 417.25);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(url);
    expect(seen[0]!.method).toBe('post');
    expect(jsonBody(seen[0]!)).toStrictEqual({ amount: 417.25 });
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

    await expect(confirm('settlement-1', 418)).rejects.toMatchObject({
      response: {
        status: 409,
        data: { error: { code: 'ATTESTED_AMOUNT_MISMATCH' } },
      },
    });
  });
});
