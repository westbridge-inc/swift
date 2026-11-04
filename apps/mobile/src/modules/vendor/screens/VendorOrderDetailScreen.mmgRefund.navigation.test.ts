/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// [BUG-HUNT-2 G08] "Refund sent" on the store's order screen, through the REAL VendorOrderDetailScreen and card over a REAL
// TanStack mutation; only native drawing, the kit, the order read and the network are stand-ins.

const fx = vi.hoisted(() => ({
  orders: {} as Record<string, any>,
  actions: [] as Array<{ label: string; action: string }>,
  act: { mutate: () => undefined, isPending: false, isError: false, error: null } as any,
  mark: (_input: unknown): Promise<unknown> => Promise.resolve(undefined),
  typed: (_text: string): void => undefined,
  sent: [] as unknown[],
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
    LabeledInput: (p: any) => { fx.typed = p.onChangeText; return h('span', null, p.value); },
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
    // The real mutation's shape: the network is fx.mark.
    useMarkRefundSent: () => useMutation({ mutationFn: (input: { id: string; reference: string; amount: string }) => { fx.sent.push(input); return fx.mark(input); } }),
  };
});

import { VendorOrderDetailScreen } from './VendorOrderDetailScreen';

const OWED = { state: 'OWED', amount: '1300.00', line: 'You owe the customer GY$1,300 by MMG. Send it from your MMG, then tap Refund sent.', sendId: null, canAnswer: false, canMarkSent: true };
const closed = (extra: Record<string, unknown> = {}) => ({
  id: 'a', orderNumber: 'SW-2001', statusHistory: [], customer: { firstName: 'Asha' }, vendor: { vendorType: 'RESTAURANT' },
  paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', items: [], fulfillment: 'PICKUP', status: 'CANCELLED', mmgRefund: OWED, ...extra,
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
const type = async (value: string) => { await act(async () => { fx.typed(value); }); await settle(); };

beforeEach(() => {
  fx.sent = [];
  fx.mark = () => Promise.resolve({ sendId: 's1', status: 'SENT' });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe('[G08] the store\'s MMG refund, on the closed order', () => {
  it('shows what the server says is owed, with its door', async () => {
    await show(closed());
    expect(host.textContent).toContain(OWED.line);
    expect(button('Refund sent')).toBeTruthy();
  });

  it('staff below a manager read it and have no door; no refund, no card', async () => {
    await show(closed({ mmgRefund: { ...OWED, canMarkSent: false } }));
    expect(host.textContent).toContain(OWED.line);
    expect(button('Refund sent')).toBeUndefined();
    await show(closed({ mmgRefund: null }));
    expect(host.textContent).not.toContain('MMG refund');
  });

  it('asks for the reference; nothing goes without one; the server\'s amount goes with it, once', async () => {
    await show(closed());
    await tap('Refund sent');
    expect(button('I sent it')!.disabled).toBe(true);
    await type('MP123456');
    await tap('I sent it');
    expect(fx.sent).toEqual([{ id: 'a', reference: 'MP123456', amount: '1300.00' }]);
    expect(dialog()).toBeNull();
  });

  it('a refusal stays on the popup in the server\'s words', async () => {
    fx.mark = () => Promise.reject(refusal('MMG_REFUND_REF_USED', 'That MMG reference is already on another refund.'));
    await show(closed());
    await tap('Refund sent');
    await type('MP123456');
    await tap('I sent it');
    expect(dialog()!.textContent).toContain('That MMG reference is already on another refund.');
  });

  it('"Not yet" sends nothing', async () => {
    await show(closed());
    await tap('Refund sent');
    await tap('Not yet');
    expect(dialog()).toBeNull();
    expect(fx.sent).toEqual([]);
  });
});
