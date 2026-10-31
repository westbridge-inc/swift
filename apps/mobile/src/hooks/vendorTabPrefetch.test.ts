import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [SPEED 30 Oct · owner] A store's tabs open with their content. Through the
// REAL store hooks (their options captured) and a REAL QueryClient: what the
// prefetch asks for is what each tab asks for, only for a role that sees it,
// once, after the board's own reads, and never twice.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  opts: [] as any[],
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  effects: [] as Array<() => void | (() => void)>,
  calls: [] as string[],
  fail: new Set<string>(),
}));

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return { ...real, useEffect: (effect: () => void | (() => void)) => { fx.effects.push(effect); }, useState: (v: unknown) => [v, vi.fn()], useCallback: (f: unknown) => f, useMemo: (f: () => unknown) => f(), useRef: (v: unknown) => ({ current: v }) };
});
vi.mock('react-native', () => ({ Vibration: { vibrate: vi.fn() } }));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useQuery: (options: unknown) => { fx.opts.push(options); return options; }, useMutation: (options: unknown) => options, useQueryClient: () => fx.client };
});
// Every vendor read answers { data: { data: <name> } }, as the API's envelope; a name in `fail` refuses.
vi.mock('../services/api', () => ({
  vendorApi: new Proxy({}, {
    get: (_target, name: string) => async () => {
      fx.calls.push(name);
      if (fx.fail.has(name)) throw Object.assign(new Error('offline'), { response: { status: 503 } });
      return { data: { data: { answer: name } } };
    },
  }),
  vendorDiscoveryApi: {},
  customerApi: {},
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({}),
  getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: () => null, requireAuthSessionSnapshot: () => null,
}));
vi.mock('../lib/billingMutation', () => ({ runBillingMutation: vi.fn() }));
vi.mock('./cashSettlement', () => ({ confirmVendorCashSettlement: vi.fn() }));
vi.mock('./partnerPricing', () => ({ usePartnerPricing: vi.fn() }));
vi.mock('./useVendorMutation', () => ({ guardVendorOperation: vi.fn(), useVendorMutation: vi.fn() }));
vi.mock('../lib/vendorPreviewData', () => ({
  vendorPreviewDataset: () => null, vendorPreviewSubscription: () => null, previewQuery: vi.fn(), previewMutation: vi.fn(), VENDOR_PREVIEW_MARKET: {},
}));
vi.mock('../services/socket', () => ({ connectSocket: vi.fn(), getSocket: () => null }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: Object.assign(() => ({}), { getState: () => ({ selectedStoreId: 'store-a' }) }) }));
vi.mock('../stores/vendorPreview', () => ({ useVendorPreview: (selector: (s: { previewType: null }) => unknown) => selector({ previewType: null }) }));

import * as hooks from './vendorops';
import { prefetchVendorTabs, useVendorTabPrefetch, vendorTabReads } from './vendorTabPrefetch';

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const keys = (reads: Array<{ queryKey: readonly unknown[] }>) => reads.map((r) => JSON.stringify(r.queryKey));

beforeEach(() => {
  fx.opts.length = 0; fx.effects.length = 0; fx.calls.length = 0; fx.fail.clear();
  fx.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { fx.client.clear(); vi.useRealTimers(); });

describe('what a store prefetches, by role (the tab bar and Account screen rules)', () => {
  it('staff (and an unknown role) prefetch nothing: their tabs are warm from the board', () => {
    expect(vendorTabReads('STAFF', false)).toEqual([]);
    expect(vendorTabReads('STAFF', true)).toEqual([]);
    expect(vendorTabReads(undefined, true)).toEqual([]);
  });

  it('a manager: Insights and promotions; Schedule only for a Services store; never the owner\'s team', () => {
    const insights = ['["vendor","analytics","popular",8]', '["vendor","cash-settlements"]', '["vendor","analytics","busy-hours"]', '["vendor","analytics","repeat-customers"]', '["vendor","standing"]', '["vendor","item-feedback"]', '["vendor","reviews"]', '["vendor","promos"]'];
    expect(keys(vendorTabReads('MANAGER', false))).toEqual(insights);
    expect(keys(vendorTabReads('MANAGER', true))).toEqual([...insights, '["vendor","bookings"]', '["vendor","booking-exceptions"]']);
    expect(keys(vendorTabReads('OWNER', false))).toEqual([...insights, '["vendor","staff"]']);
  });
});

describe('a prefetched answer is exactly what the tab would have fetched', () => {
  it.each([
    ['usePopularItems', '["vendor","analytics","popular",8]', [8]], ['useVendorCashSettlements', '["vendor","cash-settlements"]', []],
    ['useBusyHours', '["vendor","analytics","busy-hours"]', []], ['useRepeatCustomers', '["vendor","analytics","repeat-customers"]', []],
    ['useVendorStanding', '["vendor","standing"]', []], ['useVendorItemFeedback', '["vendor","item-feedback"]', []],
    ['useMyStoreReviews', '["vendor","reviews"]', []], ['useVendorPromos', '["vendor","promos"]', []], ['useVendorStaff', '["vendor","staff"]', []],
    ['useVendorBookings', '["vendor","bookings"]', []], ['useVendorBookingExceptions', '["vendor","booking-exceptions"]', []],
  ] as const)('%s: same key, same call, same answer', async (hook, key, args) => {
    (hooks as unknown as Record<string, (...a: unknown[]) => unknown>)[hook]!(...args);
    const tab = fx.opts.at(-1) as { queryKey: unknown[]; queryFn: () => Promise<unknown>; staleTime?: number };
    const read = vendorTabReads('OWNER', true).find((r) => JSON.stringify(r.queryKey) === key)!;
    expect(read, `${key} is prefetched`).toBeTruthy();
    expect(JSON.stringify(tab.queryKey)).toBe(key);
    expect(read.staleTime).toBe(tab.staleTime);
    fx.calls.length = 0;
    const fromTab = await tab.queryFn();
    const tabCalls = [...fx.calls];
    fx.calls.length = 0;
    expect(await read.queryFn()).toEqual(fromTab);
    expect(fx.calls).toEqual(tabCalls);
  });
});

describe('the prefetch', () => {
  it('reads each missing answer once and leaves a held one alone (no second request)', async () => {
    fx.client.setQueryData(['vendor', 'promos'], ['held']);
    await prefetchVendorTabs(fx.client, vendorTabReads('MANAGER', false));
    expect(fx.calls.sort()).toEqual(['analyticsBusyHours', 'analyticsPopularItems', 'analyticsRepeatCustomers', 'cashSettlements', 'itemFeedback', 'reviews', 'standing']);
    expect(fx.client.getQueryData(['vendor', 'promos'])).toEqual(['held']);
    expect(fx.client.getQueryData(['vendor', 'standing'])).toEqual({ answer: 'standing' });
    fx.calls.length = 0;
    await prefetchVendorTabs(fx.client, vendorTabReads('MANAGER', false));
    expect(fx.calls).toEqual([]);
  });

  it('a failed prefetch is forgotten: the tab later loads it the ordinary way, not as an error nobody saw', async () => {
    fx.fail.add('standing');
    await prefetchVendorTabs(fx.client, vendorTabReads('MANAGER', false));
    expect(fx.client.getQueryState(['vendor', 'standing'])).toBeUndefined();
    expect(fx.client.getQueryData(['vendor', 'reviews'])).toBeTruthy();
  });

  it('waits for the board\'s own reads, then runs once; nothing for staff or in a preview', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    void fx.client.fetchQuery({ queryKey: ['vendor', 'orders'], queryFn: () => new Promise((resolve) => { release = () => resolve([]); }) });
    useVendorTabPrefetch({ storeId: 'store-a', role: 'OWNER', isService: false, preview: false });
    const cleanup = fx.effects.at(-1)!();
    await vi.advanceTimersByTimeAsync(50);
    expect(fx.calls, 'nothing while the board is still loading').toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(50);
    await tick();
    expect(fx.calls.length).toBe(9);
    fx.calls.length = 0;
    void fx.client.invalidateQueries({ queryKey: ['vendor', 'orders'] });
    await vi.advanceTimersByTimeAsync(50);
    expect(fx.calls, 'once per store and role').toEqual([]);
    if (typeof cleanup === 'function') cleanup();

    fx.client.clear();
    fx.effects.length = 0;
    useVendorTabPrefetch({ storeId: 'store-a', isService: true, role: 'STAFF', preview: false });
    useVendorTabPrefetch({ storeId: 'store-a', isService: true, role: 'OWNER', preview: true });
    for (const effect of fx.effects) effect();
    await vi.advanceTimersByTimeAsync(50);
    expect(fx.calls, 'staff, and an owner in a sample preview').toEqual([]);
  });

  it('the store tab bar starts it, with the store\'s role, type and preview state', () => {
    const stack = readFileSync(new URL('../modules/vendor/VendorStack.tsx', import.meta.url), 'utf8');
    expect(stack).toContain('useVendorTabPrefetch({ storeId: store?.id, role: myRole, isService, preview });');
  });
});
