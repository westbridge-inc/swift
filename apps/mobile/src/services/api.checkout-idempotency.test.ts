import axios, { type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

// ---------------------------------------------------------------------------
// [TA-S1-001 / MOB-020] The checkout request carries the ATTEMPT's key.
//
// api.ts used to mint `chk_<now>_<random>` inside placeOrder, so two calls
// were two keys and the server could not tell a double tap from two orders.
// This drives the real Axios instance through a capturing adapter and reads
// the header off the wire: it is the key the hook handed in, byte for byte,
// on every call.
// ---------------------------------------------------------------------------

const env = vi.hoisted(() => {
  const previousApiUrl = process.env['EXPO_PUBLIC_API_URL'];
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  return { previousApiUrl, current: null as AuthSessionSnapshot | null };
});

vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: (): AuthSessionSnapshot | null => env.current,
  isAuthSessionSnapshotCurrent: () => false,
  useAuthStore: { getState: () => ({ rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }) },
}));
vi.mock('../stores/storeSwitcher', () => ({
  useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } }));

import { api, customerApi } from './api';

const originalAxiosAdapter = axios.defaults.adapter;
const originalApiAdapter = api.defaults.adapter;

function capturing(): { seen: InternalAxiosRequestConfig[]; adapter: AxiosAdapter } {
  const seen: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (config) => {
    seen.push(config);
    const res: AxiosResponse = { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: { orders: [] } } };
    return res;
  };
  return { seen, adapter };
}

afterEach(() => {
  axios.defaults.adapter = originalAxiosAdapter;
  api.defaults.adapter = originalApiAdapter;
  env.current = null;
});

afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

describe('customerApi.placeOrder', () => {
  it('sends exactly the key it was given as Idempotency-Key, to /customer/checkout', async () => {
    const { seen, adapter } = capturing();
    api.defaults.adapter = adapter;
    await customerApi.placeOrder({ paymentMethod: 'CASH', tipAmount: 0 }, 'chk_attempt_0123456789');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('/customer/checkout');
    expect(seen[0]!.method).toBe('post');
    expect(seen[0]!.headers.get('Idempotency-Key')).toBe('chk_attempt_0123456789');
  });

  it('two calls with the same attempt key are the same key on the wire — the server, not the client, decides they are one order', async () => {
    const { seen, adapter } = capturing();
    api.defaults.adapter = adapter;
    await customerApi.placeOrder({ paymentMethod: 'CASH' }, 'chk_same_0123456789');
    await customerApi.placeOrder({ paymentMethod: 'CASH' }, 'chk_same_0123456789');
    expect(seen.map((c) => c.headers.get('Idempotency-Key'))).toEqual(['chk_same_0123456789', 'chk_same_0123456789']);
  });
});


describe('[SX391] checkout transport captures its authorizing session', () => {
  it('POST and receipt probe preserve captured Authorization through the interceptor', async () => {
    const { seen, adapter } = capturing(); api.defaults.adapter = adapter;
    const captured = { userId: 'captured-account', generation: 1, accessToken: 'captured-access', refreshToken: 'captured-refresh' };
    // The caller owns A's captured session even if B is current before the
    // API helper runs. The current interceptor is synchronous, so switching
    // after invoking this helper would not exercise the captured binding.
    env.current = { userId: 'new-account', generation: 2, accessToken: 'new-access', refreshToken: 'new-refresh' };
    await Reflect.apply(customerApi.placeOrder, customerApi, [{ paymentMethod: 'CASH' }, 'chk_captured_0123456789', captured]);
    await Reflect.apply(customerApi.checkoutReceipt, customerApi, ['chk_captured_0123456789', captured]);
    expect(seen).toHaveLength(2);
    for (const request of seen) expect(request.headers.get('Authorization')).toBe('Bearer captured-access');
  });
});
