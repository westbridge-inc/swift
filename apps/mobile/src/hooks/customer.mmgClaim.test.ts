import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [S1-6 · R4 · F-PR1262-SOL-01] A payment claim belongs to the order it was
// opened on. React Navigation reuses the order screen for another order; the
// pending "I didn't pay" carried no order, and the claim hook sent whatever
// was confirmed to the order the screen showed at that moment — so a denial
// opened on order A could hold order B. These run the claim through the REAL
// hook and the REAL request seam (`customerApi`, captured at the axios
// adapter): only React Query's hook runtime is replaced, to hand back the
// mutation it would run. The screen's own wiring is pinned by source in
// DeliveryScreen.mmgClaim.test.ts (this suite has no react-native renderer).
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
vi.mock('react-native', () => ({ TurboModuleRegistry: { get: () => null } }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn() }));

import { api } from '../services/api';
import { useClaimMmgPayment } from './customer';
import { boundMmgClaim, sendBoundMmgClaim, type MmgClaimAction, type PendingMmgClaim } from '../modules/orders/mmgClaim';

const DENY: MmgClaimAction = {
  paid: false,
  label: 'I didn’t pay',
  confirm: { title: 'Tell us you didn’t pay?', body: 'The order pauses for a person to check.', confirmLabel: 'I didn’t pay' },
};

const originalAdapter = api.defaults.adapter;
let seen: InternalAxiosRequestConfig[] = [];
beforeEach(() => {
  seen = [];
  env.mutation = null;
  env.invalidated = [];
  const adapter: AxiosAdapter = async (config) => {
    seen.push(config);
    return { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: { orderId: 'x' } } } as AxiosResponse;
  };
  api.defaults.adapter = adapter;
});
afterEach(() => { api.defaults.adapter = originalAdapter; });
afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

const posted = () => seen.map((c) => `${c.method} ${c.url}`);
/** The hook as the order screen renders it — here, a screen now showing order B.
 *  (Before R4 the hook took that id and closed over it.) */
const renderClaimHookOnScreenShowing = (currentOrderId: string) => {
  (useClaimMmgPayment as (currentOrderId?: string) => unknown)(currentOrderId);
  return env.mutation!;
};

describe('a payment claim is sent to the order it was opened on [R4 · F-PR1262-SOL-01]', () => {
  it('the hook sends a claim to its own order, never to the order a reused screen shows now', async () => {
    const mutation = renderClaimHookOnScreenShowing('order-B');
    await mutation['mutationFn']({ orderId: 'order-A', paid: false });
    expect(posted()).toEqual(['post /customer/orders/order-A/payment-claim']);
    await mutation['onSettled'](undefined, null, { orderId: 'order-A', paid: false });
    expect(env.invalidated, 'the refetch follows the claim, not the screen').toEqual([{ queryKey: ['customer', 'order', 'order-A'] }]);
  });

  it('route switch: a denial opened on order A is neither shown nor sent once the screen shows order B — no POST to B', async () => {
    const mutation = renderClaimHookOnScreenShowing('order-B');
    const pending: PendingMmgClaim = { orderId: 'order-A', action: DENY };
    const send = (claim: { orderId: string; paid: boolean }) => { void mutation['mutationFn'](claim); };

    expect(boundMmgClaim(pending, 'order-B'), 'the confirmation is not shown for B').toBeNull();
    expect(sendBoundMmgClaim(pending, 'order-B', send), 'confirming on B sends nothing').toBe(false);
    await Promise.resolve();
    expect(posted()).toEqual([]);

    // Back on A, the same confirmation is A's to send — once, to A.
    expect(sendBoundMmgClaim(pending, 'order-A', send)).toBe(true);
    await Promise.resolve();
    expect(posted()).toEqual(['post /customer/orders/order-A/payment-claim']);
    expect(JSON.parse(String(seen[0]!.data))).toEqual({ paid: false });
  });

  it('remount: a fresh screen for order B starts with nothing to confirm or send', async () => {
    const mutation = renderClaimHookOnScreenShowing('order-B');
    expect(boundMmgClaim(null, 'order-B')).toBeNull();
    expect(sendBoundMmgClaim(null, 'order-B', (claim) => { void mutation['mutationFn'](claim); })).toBe(false);
    await Promise.resolve();
    expect(posted()).toEqual([]);
  });
});
