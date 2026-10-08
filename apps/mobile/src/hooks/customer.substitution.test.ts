import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [L09 · M028] The customer approves or declines the store's substitute, and
// the order screen must then show the decision. The order screen reads
// customerKeys.order(id) = ['customer', 'order', id]; a refresh of any other
// key leaves the screen showing the old proposal. This runs the decision
// through the REAL hook and the REAL request seam (`customerApi`, captured at
// the axios adapter): only React Query's hook runtime is replaced, to hand
// back the mutation it would run (the customer.mmgClaim.test.ts pattern).
// ---------------------------------------------------------------------------

const env = vi.hoisted(() => {
  const previousApiUrl = process.env['EXPO_PUBLIC_API_URL'];
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  return { previousApiUrl, mutation: null as null | Record<string, any>, invalidated: [] as unknown[] };
});

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: Symbol('keepPreviousData'),
  useInfiniteQuery: vi.fn(),
  useQuery: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: (filters: unknown) => { env.invalidated.push(filters); return Promise.resolve(); } }),
  useMutation: (options: Record<string, any>) => { env.mutation = options; return options; },
}));
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

import { api, customerApi } from '../services/api';
import { customerKeys, useDecideSubstitution } from './customer';

const originalAdapter = api.defaults.adapter;
let seen: InternalAxiosRequestConfig[] = [];
beforeEach(() => {
  seen = [];
  env.mutation = null;
  env.invalidated = [];
  const adapter: AxiosAdapter = async (config) => {
    seen.push(config);
    return { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: { id: 'line-1', subStatus: 'APPROVED' } } } as AxiosResponse;
  };
  api.defaults.adapter = adapter;
});
afterEach(() => { api.defaults.adapter = originalAdapter; });
afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

describe('[L09 · M028] deciding a substitute refreshes the order the screen shows', () => {
  it.each([true, false])('approve=%s is sent for that line, then the order screen\'s own query is refreshed', async (approve) => {
    useDecideSubstitution('order-7');
    const mutation = env.mutation!;
    const vars = { lineId: 'line-1', approve };
    const data = await mutation['mutationFn'](vars);
    expect(seen.map((c) => `${c.method} ${c.url}`)).toEqual(['post /customer/orders/order-7/items/line-1/substitution']);
    expect(JSON.parse(String(seen[0]!.data))).toEqual({ approve });
    await mutation['onSuccess']?.(data, vars, undefined);
    expect(env.invalidated).toContainEqual({ queryKey: customerKeys.order('order-7') });
    expect(customerKeys.order('order-7')).toEqual(['customer', 'order', 'order-7']);
  });
});

it('only the permission-aware client opts into the swap response', async () => {
  await customerApi.getOrder('order-7');
  expect(seen[0]?.url).toBe('/customer/orders/order-7');
  expect(seen[0]?.params).toEqual({ swapDecisions: 'v1' });
});
