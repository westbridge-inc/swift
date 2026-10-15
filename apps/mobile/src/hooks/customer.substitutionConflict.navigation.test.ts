/// <reference lib="dom" />
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { QueryClient, QueryObserver, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn() }));
vi.mock('../lib/marketDepthMemory', () => ({ rememberedMarketDepth: () => null, rememberMarketDepth: () => {} }));


import { api } from '../services/api';
import { customerKeys, useDecideSubstitution } from './customer';

const originalAdapter = api.defaults.adapter;
let client: QueryClient;
let observer: QueryObserver;
let seen: InternalAxiosRequestConfig[];
let rejectRequest: (() => void) | undefined;
let resolveRequest: (() => void) | undefined;
let refusal = 409;
let mutation: ReturnType<typeof useDecideSubstitution>;
// The probe re-renders with another order id (a reused screen); the hook takes no order.
function Probe({ id }: { id: string }) {
  void id;
  mutation = useDecideSubstitution();
  return null;
}
beforeEach(() => {
  seen = []; rejectRequest = undefined; resolveRequest = undefined; refusal = 409;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  client.setQueryData(customerKeys.order('order-A'), { id: 'order-A', status: 'PENDING' });
  client.setQueryData(customerKeys.order('order-B'), { id: 'order-B', status: 'PENDING' });
  observer = new QueryObserver(client, {
    queryKey: customerKeys.order('order-A'), staleTime: Infinity,
    queryFn: async () => (await api.get('/customer/orders/order-A')).data.data,
  });
  observer.subscribe(() => {});
  api.defaults.adapter = async (config) => {
    seen.push(config);
    const response = { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: { id: 'order-A', status: 'APPROVED' } } };
    if (config.method === 'post') return await new Promise((resolve, reject) => {
      rejectRequest = () => reject(new AxiosError('Refused', 'ERR_BAD_REQUEST', config, undefined,
        { ...response, status: refusal, data: { success: false, error: { code: 'NOT_PENDING' } } }));
      resolveRequest = () => resolve(response);
    });
    return response;
  };
});
afterEach(() => { observer.destroy(); client.clear(); api.defaults.adapter = originalAdapter; });
afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

async function submitAndNavigate(approve: boolean, outcome: 'conflict' | 'success' | 'ordinary', navigate: boolean) {
  const root = createRoot(document.createElement('div'));
  const render = (id: string) => createElement(QueryClientProvider, { client }, createElement(Probe, { id }));
  let pending: Promise<unknown> | undefined;
  try {
    await act(async () => { root.render(render('order-A')); });
    await act(async () => {
      pending = mutation.mutateAsync({ orderId: 'order-A', lineId: 'line-1', approve }).catch((error: unknown) => error);
      await vi.waitFor(() => expect(rejectRequest).toBeTypeOf('function'));
    });
    expect(seen.filter((r) => r.method === 'post')).toHaveLength(1);
    expect(seen[0]?.url).toBe('/customer/orders/order-A/items/line-1/substitution');
    expect(JSON.parse(seen[0]?.data as string)).toEqual({ approve });
    if (navigate) await act(async () => { root.render(render('order-B')); });
    await act(async () => {
      refusal = outcome === 'ordinary' ? 400 : 409;
      if (outcome === 'success') resolveRequest!(); else rejectRequest!();
      await pending;
    });
    expect(seen.filter((r) => r.method === 'get').map((r) => r.url)).toEqual(outcome === 'ordinary' ? [] : ['/customer/orders/order-A']);
    expect(client.getQueryData(customerKeys.order('order-A'))).toEqual({ id: 'order-A', status: outcome === 'ordinary' ? 'PENDING' : 'APPROVED' });
    expect(client.getQueryState(customerKeys.order('order-B'))?.isInvalidated).toBe(false);
  } finally {
    if (pending && rejectRequest) { rejectRequest(); await pending; }
    await act(async () => { root.unmount(); });
  }
}

describe('substitution decision uses the submitted order across navigation', () => {
  it.each([true, false])('approve=%s sends the request and refreshes after conflict', async (approve) => {
    await submitAndNavigate(approve, 'conflict', false);
  });
  it.each([true, false])('late approve=%s conflict refreshes A after navigating to B', async (approve) => {
    await submitAndNavigate(approve, 'conflict', true);
  });
  it('a late successful decision refreshes the submitted order', async () => {
    await submitAndNavigate(true, 'success', true);
  });
  it('an ordinary refusal leaves both snapshots intact', async () => {
    await submitAndNavigate(false, 'ordinary', true);
  });
});
