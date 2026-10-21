/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [UI-SWEEP U10 · REVIEW-F #1902 S3-1] A tap to a screen already in the stack
// goes BACK to that screen (navigate + pop), and a business push for another
// order while this screen is open re-uses it too: React Navigation keeps the
// SAME mounted screen and hands it the new route. The order screen's local
// ceremony (the typed collection code, an open Reject / Confirm delivered
// popup, a swap picker) used to survive the switch, so order A's half-done
// hand-over could act on order B. The REAL VendorOrderDetailScreen on a real
// React renderer; only native drawing, the kit, the order reads and the
// network are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  orders: {} as Record<string, any>,
  mutate: vi.fn(),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
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
    CodeInput: (p: any) => h('input', { 'aria-label': 'collection code', value: p.value, onChange: (e: any) => p.onChange(e.target.value) }),
    PillButton: (p: any) => h('button', { type: 'button', 'data-pill': p.label, disabled: !!p.disabled, onClick: p.disabled ? undefined : p.onPress }, p.label),
    PopupCard: (p: any) => p.visible ? h('div', { role: 'dialog' }, p.children) : null,
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: vi.fn() }));
vi.mock('../../orders/CustodyRecoveryNotice', () => ({ CustodyRecoveryNotice: () => null }));
vi.mock('../shared', async () => {
  const R = await import('react');
  return {
    GUTTER: 16,
    SubHeader: (p: any) => R.createElement('header', null, p.title),
    OrderStatusPill: () => null, FulfillmentTag: () => null, MmgDisputeNotice: () => null,
    fmtClock: () => '', fmtWhen: () => '', formatSlot: () => '', prettyStatus: (s: string) => s,
    // The real board's choice for the three states under test (shared.tsx statusActions).
    orderActions: (order: any) => order.status === 'PENDING'
      ? [{ label: 'Accept', action: 'accept' }, { label: 'Reject', action: 'reject' }]
      : order.status === 'READY_FOR_PICKUP' && order.fulfillment === 'PICKUP'
        ? [{ label: 'Mark picked up', action: 'complete-pickup' }]
        : order.status === 'RIDER_EN_ROUTE_DELIVERY' ? [{ label: 'Confirm delivered', action: 'delivered' }] : [],
  };
});
vi.mock('../../../hooks/vendorops', () => {
  const idle = () => ({ mutate: fx.mutate, isPending: false, isError: false, error: null });
  return {
    useVendorOrder: (id?: string) => ({ data: id ? fx.orders[id] : undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    useOrderAction: idle, useRetryDispatch: idle, useSetOrderFulfillmentMode: idle, useReturnReceived: idle,
    usePickingActions: () => ({ setPicked: idle(), substitute: idle(), refundLine: idle() }),
    useVendorMenu: () => ({ data: [] }),
  };
});

import { VendorOrderDetailScreen } from './VendorOrderDetailScreen';

const order = (id: string, extra: Record<string, unknown>) => ({
  id, orderNumber: id.toUpperCase(), items: [], statusHistory: [], customer: { firstName: `Customer ${id}` },
  vendor: { vendorType: 'RESTAURANT' }, paymentMethod: 'CASH', ...extra,
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const navigation = { goBack: vi.fn(), navigate: vi.fn() };
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[data-pill="${label}"]`);
const click = async (el: Element) => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
async function typeCode(value: string) {
  const el = host.querySelector<HTMLInputElement>('input[aria-label="collection code"]')!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); });
}
/** React Navigation re-renders the SAME mounted screen with the new route (navigate + pop, or a push for the open screen). */
async function show(orderId: string) {
  await act(async () => root.render(React.createElement(VendorOrderDetailScreen, {
    navigation, route: { name: 'VendorOrderDetail', params: { orderId } },
  })));
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[UI-SWEEP U10 S3-1] the store order screen, reused for another order, starts clean', () => {
  it('order A’s typed collection code never completes order B', async () => {
    fx.orders = {
      a: order('a', { status: 'READY_FOR_PICKUP', fulfillment: 'PICKUP' }),
      b: order('b', { status: 'READY_FOR_PICKUP', fulfillment: 'PICKUP' }),
    };
    await show('a');
    await typeCode('123456');
    expect(button('Mark picked up')!.disabled).toBe(false);

    await show('b');

    expect(host.querySelector<HTMLInputElement>('input[aria-label="collection code"]')!.value, 'A’s code is gone').toBe('');
    expect(button('Mark picked up')!.disabled, 'B waits for B’s own code').toBe(true);
    expect(fx.mutate).not.toHaveBeenCalled();
  });

  it('an open Reject popup for order A is closed when the screen shows order B', async () => {
    fx.orders = { a: order('a', { status: 'PENDING', fulfillment: 'DELIVERY' }), b: order('b', { status: 'PENDING', fulfillment: 'DELIVERY' }) };
    await show('a');
    await click(button('Reject')!);
    expect(host.querySelector('[role="dialog"]'), 'the reject popup is open on A').not.toBeNull();

    await show('b');

    expect(host.querySelector('[role="dialog"]'), 'no popup carries across to B').toBeNull();
    expect(fx.mutate).not.toHaveBeenCalled();
  });

  it('an open Confirm delivered popup for order A is closed when the screen shows order B', async () => {
    const selfDelivery = { status: 'RIDER_EN_ROUTE_DELIVERY', fulfillment: 'DELIVERY', fulfillmentMode: 'VENDOR', vendor: { vendorType: 'RESTAURANT', selfDeliveryEnabled: true } };
    fx.orders = { a: order('a', selfDelivery), b: order('b', selfDelivery) };
    await show('a');
    await click(button('Confirm delivered')!);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();

    await show('b');

    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(fx.mutate).not.toHaveBeenCalled();
  });

  it('the SAME order handed again keeps the typed code (no reset without a new id)', async () => {
    fx.orders = { a: order('a', { status: 'READY_FOR_PICKUP', fulfillment: 'PICKUP' }) };
    await show('a');
    await typeCode('123456');
    await show('a');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="collection code"]')!.value).toBe('123456');
  });
});
