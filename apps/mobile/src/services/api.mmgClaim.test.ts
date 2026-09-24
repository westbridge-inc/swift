import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
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
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ TurboModuleRegistry: { get: () => null } }));

import { api, customerApi } from './api';

const originalAdapter = api.defaults.adapter;
afterEach(() => { api.defaults.adapter = originalAdapter; });
afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

function capture(data: unknown) {
  const seen: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (config) => {
    seen.push(config);
    return { config, status: 200, statusText: 'OK', headers: {}, data } as AxiosResponse;
  };
  api.defaults.adapter = adapter;
  return seen;
}
const body = (c: InternalAxiosRequestConfig) => (typeof c.data === 'string' ? JSON.parse(c.data) : c.data);

describe('[S1-6] the customer can tell Swift what happened to their MMG payment', () => {
  it('"I didn\'t pay" is one POST to the customer claim route, and the answer is unwrapped at the seam', async () => {
    const seen = capture({ success: true, data: { orderId: 'order-1', mismatch: true, paymentStatus: 'CLAIMED' } });
    const result = await customerApi.claimOrderPayment('order-1', { paid: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('post');
    expect(seen[0]!.url).toBe('/customer/orders/order-1/payment-claim');
    expect(body(seen[0]!)).toEqual({ paid: false });
    expect(result).toEqual({ orderId: 'order-1', mismatch: true, paymentStatus: 'CLAIMED' });
  });

  it('a reference travels only with "I paid"', async () => {
    const seen = capture({ success: true, data: { orderId: 'order-1' } });
    await customerApi.claimOrderPayment('order-1', { paid: true, reference: 'MMG12345' });
    await customerApi.claimOrderPayment('order-1', { paid: false, reference: 'MMG12345' });
    expect(body(seen[0]!)).toEqual({ paid: true, reference: 'MMG12345' });
    expect(body(seen[1]!)).toEqual({ paid: false });
  });
});
