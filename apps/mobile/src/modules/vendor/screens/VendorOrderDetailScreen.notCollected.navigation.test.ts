/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// [BUG-HUNT-2 G20] "Not collected" on the store's order screen, through the REAL VendorOrderDetailScreen and popup over a REAL
// TanStack mutation; only native drawing, the kit, the order read and the network are stand-ins.

const fx = vi.hoisted(() => ({
  orders: {} as Record<string, any>,
  actions: [] as Array<{ label: string; action: string }>,
  act: { mutate: () => undefined, isPending: false, isError: false, error: null } as any,
  notCollected: (_id: string): Promise<unknown> => Promise.resolve(undefined),
  sent: [] as string[],
  refetch: vi.fn(),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', { 'data-testid': p.testID }, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return { View, ScrollView: View, Pressable: View, Linking: { openURL: vi.fn() } };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  return {
    Card: Box, Screen: Box, InfoRow: () => null, IconChip: () => null, LoadingBlock: () => null, ErrorState: () => null,
    T: (p: any) => h('span', null, p.children), PopupTitle: (p: any) => h('h2', null, p.children),
    Chip: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
    CodeInput: () => h('input', { 'aria-label': 'Pickup code' }),
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress, disabled: !!p.disabled }, p.label),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: vi.fn() }));
vi.mock('../../orders/CustodyRecoveryNotice', () => ({ CustodyRecoveryNotice: () => null }));
vi.mock('../shared', async () => {
  const R = await import('react');
  return {
    GUTTER: 16,
    SubHeader: (p: any) => R.createElement('header', null, p.title),
    OrderStatusPill: () => null, FulfillmentTag: () => null, MmgDisputeNotice: () => null,
    fmtClock: () => '', fmtWhen: () => '', formatSlot: () => '',
    orderActions: () => fx.actions,
  };
});
vi.mock('../../../hooks/vendorops', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  const idle = () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null });
  return {
    useVendorOrder: (id?: string) => ({ data: id ? fx.orders[id] : undefined, isLoading: false, isError: false, refetch: fx.refetch }),
    useOrderAction: () => fx.act, useRetryDispatch: idle, useSetOrderFulfillmentMode: idle, useReturnReceived: idle,
    usePickingActions: () => ({ setPicked: idle(), substitute: idle(), refundLine: idle() }),
    usePendingPickLines: () => new Set(),
    useVendorMenu: () => ({ data: [] }),
    useMarkNoShow: idle,
    // The real mutation's shape: the network is fx.notCollected.
    useMarkNotCollected: () => useMutation({ mutationFn: (id: string) => { fx.sent.push(id); return fx.notCollected(id); } }),
  };
});

import { VendorOrderDetailScreen } from './VendorOrderDetailScreen';

const pickup = (extra: Record<string, unknown> = {}) => ({
  id: 'a', orderNumber: 'SW-2001', statusHistory: [], customer: { firstName: 'Asha' }, vendor: { vendorType: 'RESTAURANT' },
  paymentMethod: 'CASH', items: [], fulfillment: 'PICKUP', status: 'READY_FOR_PICKUP', notCollected: { allowed: true, goesToSupport: false }, ...extra,
});
const refusal = (code: string, message: string) => Object.assign(new Error('Request failed with status code 409'), {
  response: { status: 409, data: { success: false, error: { code, message } } },
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const dialog = () => host.querySelector('[role="dialog"]');
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
async function show(o: Record<string, unknown>) {
  fx.orders = { a: o };
  fx.actions = [];
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(VendorOrderDetailScreen, {
    navigation: { goBack: vi.fn(), navigate: vi.fn() }, route: { name: 'VendorOrderDetail', params: { orderId: 'a' } },
  }))));
  await settle();
}
const tap = async (label: string) => {
  const b = button(label);
  expect(b, label).toBeTruthy();
  await act(async () => { b!.click(); });
  await settle();
};

beforeEach(() => {
  fx.sent = [];
  fx.notCollected = () => Promise.resolve(undefined);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe('[G20] "Not collected" on the store\'s order screen', () => {
  it('shows only on the server\'s word', async () => {
    await show(pickup());
    expect(button('Not collected')).toBeTruthy();
    expect(dialog(), 'nothing asked before the tap').toBeNull();
    await show(pickup({ notCollected: { allowed: false, goesToSupport: false } }));
    expect(button('Not collected')).toBeUndefined();
    await show(pickup({ notCollected: undefined }));
    expect(button('Not collected')).toBeUndefined();
  });

  it('never beside a closed or a delivery order, whatever a word says', async () => {
    await show(pickup({ status: 'COMPLETED' }));
    expect(button('Not collected')).toBeUndefined();
    await show(pickup({ fulfillment: 'DELIVERY' }));
    expect(button('Not collected')).toBeUndefined();
  });

  it('asks first; "Keep the order" sends nothing', async () => {
    await show(pickup());
    await tap('Not collected');
    expect(dialog()!.textContent).toContain('Mark as not collected?');
    expect(dialog()!.textContent).toContain('The order closes. No money moves. The customer is told.');
    expect(fx.sent).toEqual([]);
    await tap('Keep the order');
    expect(dialog()).toBeNull();
    expect(fx.sent).toEqual([]);
  });

  it('a cash order: sent once, then the closed state', async () => {
    fx.notCollected = () => Promise.resolve({ id: 'a', status: 'CANCELLED' });
    await show(pickup());
    await tap('Not collected');
    await tap('Yes, nobody came');
    expect(fx.sent).toEqual(['a']);
    expect(dialog()!.textContent).toContain('Order closed');
    expect(dialog()!.textContent).toContain('Recorded: not collected. No money moved.');
    expect(button('Yes, nobody came')).toBeUndefined();
    await tap('Done');
    expect(dialog()).toBeNull();
  });

  it('a paid MMG order says it goes to support, and that it stays open', async () => {
    fx.notCollected = () => Promise.resolve({ id: 'a', status: 'READY_FOR_PICKUP', sentToSupport: true });
    await show(pickup({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', notCollected: { allowed: true, goesToSupport: true } }));
    await tap('Not collected');
    expect(dialog()!.textContent).toContain('It was paid by MMG, so Swift support closes it with you. The order stays open until they do.');
    await tap('Yes, nobody came');
    expect(dialog()!.textContent).toContain('With Swift support');
    expect(dialog()!.textContent).toContain('Swift support has this order. They close it and record the refund you owe the customer.');
  });

  it('a refusal stays on the popup in the server\'s words', async () => {
    fx.notCollected = () => Promise.reject(refusal('NOT_COLLECTED_NOT_OPEN', 'Only a pickup that is ready and waiting can be marked Not collected.'));
    await show(pickup());
    await tap('Not collected');
    await tap('Yes, nobody came');
    expect(dialog()!.textContent).toContain('Only a pickup that is ready and waiting can be marked Not collected.');
    expect(button('Yes, nobody came')).toBeTruthy();
  });
});
