/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [STORE-DASH · owner 22 Oct 2026 "fast taps and simple"] Two board facts,
// driven through the REAL hooks on a real React renderer and a real query
// cache (only the network is a stand-in):
//   1. Only the order that was tapped waits. The board read one shared
//      isPending, so a tap on order A disabled every other card until A's
//      answer came back. usePendingOrderIds names exactly the orders whose
//      tap is still out.
//   2. An order opens at once from the board's own copy of it; the order's
//      own read replaces that copy when it answers.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  answers: {} as Record<string, (v: unknown) => void>,
  detail: {} as Record<string, (v: unknown) => void>,
}));

vi.mock('react-native', () => ({ Vibration: { vibrate: vi.fn() } }));
vi.mock('../services/api', () => {
  const later = (bag: Record<string, (v: unknown) => void>, id: string) =>
    new Promise((resolve) => { bag[id] = (data: unknown) => resolve({ data: { success: true, data } }); });
  return {
    vendorApi: {
      acceptOrder: (id: string) => later(fx.answers, id),
      ready: (id: string) => later(fx.answers, id),
      order: (id: string) => later(fx.detail, id),
    },
    vendorDiscoveryApi: {},
  };
});
vi.mock('../services/socket', () => ({ connectSocket: vi.fn(), getSocket: () => ({ connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() }) }));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({}),
  getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: () => null, requireAuthSessionSnapshot: () => null,
}));
vi.mock('../lib/billingMutation', () => ({ runBillingMutation: vi.fn() }));
vi.mock('./cashSettlement', () => ({ confirmVendorCashSettlement: vi.fn() }));
vi.mock('./partnerPricing', () => ({ usePartnerPricing: vi.fn() }));
vi.mock('../stores/storeSwitcher', () => ({
  useStoreSwitcher: Object.assign((selector?: (s: unknown) => unknown) => (selector ? selector({ selectedStoreId: 'store-a' }) : { selectedStoreId: 'store-a' }), {
    getState: () => ({ selectedStoreId: 'store-a', storeGeneration: 1 }),
  }),
}));
vi.mock('../stores/vendorPreview', () => ({ useVendorPreview: (selector: (s: { previewType: null }) => unknown) => selector({ previewType: null }) }));

import { useOrderAction, usePendingOrderIds, useVendorOrder } from './vendorops';

let root: { render: (n: React.ReactNode) => void; unmount: () => void } | null = null;
let host: HTMLElement | null = null;
let qc: QueryClient;
const seen: { pending: string[]; mutate: ((v: { id: string; action: 'accept' | 'ready' }) => void) | null; order: any; placeholder: boolean | undefined } = {
  pending: [], mutate: null, order: undefined, placeholder: undefined,
};

function Board() {
  const act = useOrderAction();
  const pending = usePendingOrderIds();
  seen.pending = [...pending].sort();
  seen.mutate = (v) => act.mutate(v);
  return null;
}
function Detail({ id }: { id: string }) {
  const q = useVendorOrder(id);
  seen.order = q.data;
  seen.placeholder = q.isPlaceholderData;
  return null;
}

async function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(QueryClientProvider, { client: qc }, node)); });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  for (const bag of [fx.answers, fx.detail]) for (const k of Object.keys(bag)) delete bag[k];
  seen.pending = []; seen.mutate = null; seen.order = undefined; seen.placeholder = undefined;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null; host = null;
});

describe('[STORE-DASH] only the tapped order waits', () => {
  it('two taps out at once: both orders are waiting, each one is freed by its OWN answer', async () => {
    await mount(React.createElement(Board));
    await act(async () => { seen.mutate!({ id: 'order-a', action: 'accept' }); });
    await flush();
    expect(seen.pending).toEqual(['order-a']);
    await act(async () => { seen.mutate!({ id: 'order-b', action: 'ready' }); });
    await flush();
    expect(seen.pending).toEqual(['order-a', 'order-b']);

    await act(async () => { fx.answers['order-a']!({ id: 'order-a', status: 'PREPARING' }); });
    await flush();
    expect(seen.pending).toEqual(['order-b']);

    await act(async () => { fx.answers['order-b']!({ id: 'order-b', status: 'READY_FOR_PICKUP' }); });
    await flush();
    expect(seen.pending).toEqual([]);
  });

  it('an order nobody tapped is never waiting', async () => {
    await mount(React.createElement(Board));
    await act(async () => { seen.mutate!({ id: 'order-a', action: 'accept' }); });
    await flush();
    expect(seen.pending).toEqual(['order-a']);
    expect(seen.pending).not.toContain('order-c');
  });
});

describe('[STORE-DASH] an order opens at once from the board', () => {
  it('the board copy shows first (marked as such), then the order\'s own read replaces it', async () => {
    qc.setQueryData(['vendor', 'orders'], [{ id: 'o1', status: 'PREPARING', orderNumber: '1001', items: [{ id: 'l1', name: 'Rice' }] }]);
    await mount(React.createElement(Detail, { id: 'o1' }));
    expect(seen.order).toMatchObject({ id: 'o1', status: 'PREPARING', orderNumber: '1001' });
    expect(seen.placeholder).toBe(true);

    await act(async () => { fx.detail['o1']!({ id: 'o1', status: 'PREPARING', orderNumber: '1001', items: [{ id: 'l1', name: 'Rice', picked: true }], statusHistory: [] }); });
    await flush();
    expect(seen.placeholder).toBe(false);
    expect(seen.order.items[0].picked).toBe(true);
  });

  it('an order the board does not hold waits for its own read (no made-up copy)', async () => {
    qc.setQueryData(['vendor', 'orders'], [{ id: 'other', status: 'PENDING' }]);
    await mount(React.createElement(Detail, { id: 'o9' }));
    expect(seen.order).toBeUndefined();
  });
});
