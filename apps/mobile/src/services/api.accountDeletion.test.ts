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
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } }));

import { api, customerApi } from './api';

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
    return { config, status: 202, statusText: 'Accepted', headers: {}, data: { success: true, data: {} } } as AxiosResponse;
  };
  api.defaults.adapter = adapter;
  return seen;
}

describe('[DELETION-INTEGRITY] account deletion declares that this app shows every receipt by its message', () => {
  // The server answers an app that does not declare this (the build in store
  // review) in that build's words, so it never reports an open account as
  // deleted. This app reads every receipt's message, so it declares it.
  it('DELETE /customer/account carries receipts=v2', async () => {
    const seen = capture();
    await customerApi.deleteAccount();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('delete');
    expect(seen[0]!.url).toBe('/customer/account');
    expect(seen[0]!.params).toEqual({ receipts: 'v2' });
  });

  it('the closure request is its own route and needs no declaration', async () => {
    const seen = capture();
    await customerApi.requestAccountClosure();
    expect(seen[0]!.method).toBe('post');
    expect(seen[0]!.url).toBe('/customer/account/closure-request');
  });
});
