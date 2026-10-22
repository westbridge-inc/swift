import {
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } }));

import { api, vendorApi } from './api';

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

// [owner 21 Oct · COORD 03:15Z] The store switches send the state they should END in. The server used
// to flip whatever it held, so a tap on a screen that was behind did the opposite of what it showed
// (a "Close" opened the store). It now honours a desired state and flips only for apps that send none.
describe('the store switches tell the server the state they want', () => {
  function capture(): Array<{ url?: string; method?: string; body: unknown }> {
    const seen: Array<{ url?: string; method?: string; body: unknown }> = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push({ url: config.url, method: config.method, body: jsonBody(config) });
      return response(config, 200, { success: true, data: { isCurrentlyOpen: false, acceptingOrders: true } });
    };
    api.defaults.adapter = adapter;
    return seen;
  }

  it('Store open sends isCurrentlyOpen, both ways', async () => {
    const seen = capture();
    await vendorApi.toggleOpen(false);
    await vendorApi.toggleOpen(true);
    expect(seen).toEqual([
      { url: '/vendor/vendor/toggle-open', method: 'put', body: { isCurrentlyOpen: false } },
      { url: '/vendor/vendor/toggle-open', method: 'put', body: { isCurrentlyOpen: true } },
    ]);
  });

  it('Pause / Resume orders sends acceptingOrders, both ways', async () => {
    const seen = capture();
    await vendorApi.toggleOrders(false);
    await vendorApi.toggleOrders(true);
    expect(seen).toEqual([
      { url: '/vendor/vendor/toggle-orders', method: 'put', body: { acceptingOrders: false } },
      { url: '/vendor/vendor/toggle-orders', method: 'put', body: { acceptingOrders: true } },
    ]);
  });
});

describe('the store screen sends the opposite of what it shows, through the hooks', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');
  it('VendorOps passes the wanted state; the hooks hand it to the API unchanged', () => {
    const screen = read('modules', 'vendor', 'screens', 'VendorOps.tsx');
    expect(screen).toContain('onPress={() => toggleOpen.mutate(!open)}');
    expect(screen).toContain('onPress={() => toggleOrders.mutate(!accepting)}');
    const hooks = read('hooks', 'vendorops.ts');
    expect(hooks).toContain('mutationFn: (open: boolean) => unwrap(vendorApi.toggleOpen(open)),');
    expect(hooks).toContain('mutationFn: (accepting: boolean) => unwrap(vendorApi.toggleOrders(accepting)),');
  });
});
