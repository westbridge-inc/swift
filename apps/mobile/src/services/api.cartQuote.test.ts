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

// ---------------------------------------------------------------------------
// [E01] The cart quote travels with checkout's choices, in the one wire format
// the API accepts: `express` only as "true", the store-by-store selection as
// checkout's record in JSON (the API's query parser has no bracket syntax), the
// tip as a whole number. The URL is the one axios actually builds.
// ---------------------------------------------------------------------------

const originalAdapter = api.defaults.adapter;
afterEach(() => { api.defaults.adapter = originalAdapter; });
afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

function capture() {
  const seen: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (config) => {
    seen.push(config);
    return { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: null } } as AxiosResponse;
  };
  api.defaults.adapter = adapter;
  return seen;
}
/** The query exactly as it leaves the phone, decoded the way a server does. */
const sentQuery = (config: InternalAxiosRequestConfig) => new URL(api.getUri(config)).searchParams;

describe('GET /customer/cart carries the checkout choices', () => {
  it('no choices: only the coordinates — the server prices checkout’s defaults', async () => {
    const seen = capture();
    await customerApi.getCart(6.81, -58.17);
    const q = sentQuery(seen[0]!);
    expect([...q.keys()].sort()).toEqual(['lat', 'lng']);
  });

  it('express goes only as "true" — never the string "false" a coercing parser would read as express', async () => {
    const seen = capture();
    await customerApi.getCart(undefined, undefined, { express: true });
    await customerApi.getCart(undefined, undefined, {});
    expect(sentQuery(seen[0]!).getAll('express')).toEqual(['true']);
    expect(sentQuery(seen[1]!).has('express')).toBe(false);
  });

  it('every store’s pickup choice arrives as checkout’s own record, intact', async () => {
    const seen = capture();
    const fulfillmentSelections = { cmnear0000000001: 'PICKUP' as const, cmfar00000000002: 'PICKUP' as const };
    await customerApi.getCart(6.81, -58.17, { fulfillmentSelections, tipAmount: 0 });
    const q = sentQuery(seen[0]!);
    expect(JSON.parse(q.get('fulfillmentSelections')!)).toEqual(fulfillmentSelections);
    expect(q.get('tipAmount')).toBe('0');
    // Never bracket syntax: the API's parser would read it as one flat key.
    expect(api.getUri(seen[0]!)).not.toMatch(/fulfillmentSelections%5B|fulfillmentSelections\[/);
  });

  it('a chosen tip travels as a whole number; an empty selection is not sent', async () => {
    const seen = capture();
    await customerApi.getCart(undefined, undefined, { tipAmount: 500, fulfillmentSelections: {} });
    const q = sentQuery(seen[0]!);
    expect(q.get('tipAmount')).toBe('500');
    expect(q.has('fulfillmentSelections')).toBe(false);
  });
});
