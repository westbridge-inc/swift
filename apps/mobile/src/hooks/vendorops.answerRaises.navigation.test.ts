/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [STORE-DASH · REVIEW-F S3-1 on #2048] When the customer answers the store's
// "Out of stock" question, the server sends no push (only order:pick_state,
// which re-reads the board) and the store's response clock restarts from the
// answer. The phone's live layer (the REAL useVendorOrdersLive on a real React
// renderer and query cache) raises the new-order screen again for that order,
// on the board's fresh copy, so a busy kitchen never misses the reply.
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

import { useVendorOrdersLive } from './vendorops';

let root: { render: (n: React.ReactNode) => void; unmount: () => void } | null = null;
let host: HTMLElement | null = null;
let qc: QueryClient;
const seen: { takeover: Array<{ orderId: string; orderNumber?: string }> } = { takeover: [] };

function Layer() {
  const { takeover } = useVendorOrdersLive('store-a', false);
  seen.takeover = takeover;
  return null;
}
async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(Layer))); });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const order = (id: string, items: unknown[]) => ({ id, orderNumber: id.toUpperCase(), status: 'PENDING', items });
const asked = { id: 'l1', subStatus: 'PENDING', substituteName: null };

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  seen.takeover = [];
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null; host = null;
});

describe('[STORE-DASH] the customer\'s answer raises the new-order screen again', () => {
  it('asked -> answered: the order is on the new-order screen again, and its stale copy is dropped', async () => {
    qc.setQueryData(['vendor', 'orders'], [order('o1', [asked, { id: 'l2', subStatus: 'NONE' }])]);
    qc.setQueryData(['vendor', 'orders', 'detail', 'o1'], order('o1', [asked]));
    await mount();
    expect(seen.takeover).toEqual([]);
    await act(async () => { qc.setQueryData(['vendor', 'orders'], [order('o1', [{ id: 'l1', subStatus: 'REFUNDED' }, { id: 'l2', subStatus: 'NONE' }])]); });
    await flush();
    expect(seen.takeover).toEqual([{ orderId: 'o1', orderNumber: 'O1' }]);
    expect(qc.getQueryData(['vendor', 'orders', 'detail', 'o1'])).toBeUndefined();
  });

  it('control: an order nobody asked about never comes back by itself; still deciding stays quiet', async () => {
    qc.setQueryData(['vendor', 'orders'], [order('o2', [{ id: 'l1', subStatus: 'NONE' }]), order('o3', [asked])]);
    await mount();
    await act(async () => { qc.setQueryData(['vendor', 'orders'], [order('o2', [{ id: 'l1', subStatus: 'NONE' }]), order('o3', [asked])]); });
    await flush();
    expect(seen.takeover).toEqual([]);
  });
});
