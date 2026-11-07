/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct] The order screen's pick list: each line's tick waits alone (a second tap on a box whose tick is
// still on its way sends nothing; another line's box goes through), and the step buttons wait while a tick is still
// out (a "Ready" sent before it lands would be refused for an unpicked line). The tick itself shows at the tap from the
// order's own data (hooks/vendorops usePickingActions, pinned in vendorops.orderTaps.test.ts). The REAL
// VendorOrderDetailScreen on a real React renderer; native drawing, the kit and the hooks are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  orders: {} as Record<string, any>,
  pick: { mutate: vi.fn(), isPending: false, isError: false, error: null } as any,
  act: { mutate: vi.fn(), isPending: false, isError: false, error: null } as any,
  out: new Set<string>(),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  const Pressable = (p: any) => R.createElement('button', { type: 'button', 'aria-label': p.accessibilityLabel, disabled: !!p.disabled, onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return { View, ScrollView: View, Pressable, Linking: { openURL: vi.fn() } };
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
    CodeInput: () => null,
    PillButton: (p: any) => h('button', { type: 'button', disabled: !!p.disabled, onClick: p.disabled ? undefined : p.onPress }, p.label),
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
    fmtClock: () => '', fmtWhen: () => '', formatSlot: () => '',
    // The old history helper (code with spaces), so a screen that still uses it renders its real old words.
    prettyStatus: (s?: string) => { const t = (s || '').replace(/_/g, ' ').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); },
    orderActions: () => [{ label: 'Ready for delivery', action: 'ready' }],
  };
});
vi.mock('../../../hooks/vendorops', () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null });
  return {
    useVendorOrder: (id?: string) => ({ data: id ? fx.orders[id] : undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    useOrderAction: () => fx.act, useRetryDispatch: idle, useSetOrderFulfillmentMode: idle, useReturnReceived: idle,
    usePickingActions: () => ({ setPicked: fx.pick, substitute: idle(), refundLine: idle() }),
    usePendingPickLines: () => fx.out,
    useVendorMenu: () => ({ data: [] }),
  };
});

import { VendorOrderDetailScreen } from './VendorOrderDetailScreen';

const line = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, itemId: `item-${id}`, name, quantity: 2, totalBase: 1000, subStatus: 'NONE', picked: false, ...extra });
const order = () => ({
  id: 'a', orderNumber: 'A', status: 'PREPARING', statusHistory: [], customer: { firstName: 'Customer' },
  vendor: { vendorType: 'SUPERMARKET' }, paymentMethod: 'CASH', fulfillment: 'DELIVERY',
  items: [line('l1', 'Rice'), line('l2', 'Oil')],
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function show() {
  fx.orders = { a: order() };
  await act(async () => root.render(React.createElement(VendorOrderDetailScreen, {
    navigation: { goBack: vi.fn(), navigate: vi.fn() }, route: { name: 'VendorOrderDetail', params: { orderId: 'a' } },
  })));
}
const tick = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Picked: 2× ${name}"]`)!;
const step = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Ready for delivery') as HTMLButtonElement;

beforeEach(() => {
  fx.pick.mutate = vi.fn();
  fx.act.mutate = vi.fn();
  fx.out = new Set();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[TAP-AUDIT] the phone pick list', () => {
  it('a tick is sent for its own line', async () => {
    await show();
    await act(async () => { tick('Rice').click(); });
    expect(fx.pick.mutate).toHaveBeenCalledWith({ orderId: 'a', lineId: 'l1', picked: true });
  });

  it('a second tap on a box whose tick is still out sends nothing; another line goes through', async () => {
    fx.out = new Set(['l1']);
    await show();
    expect(tick('Rice').disabled).toBe(true);
    await act(async () => { tick('Rice').click(); });
    expect(fx.pick.mutate).not.toHaveBeenCalled();
    await act(async () => { tick('Oil').click(); });
    expect(fx.pick.mutate).toHaveBeenCalledWith({ orderId: 'a', lineId: 'l2', picked: true });
  });

  it('the step button waits while a tick is out', async () => {
    await show();
    expect(step().disabled).toBe(false);
    fx.out = new Set(['l1']);
    await show();
    expect(step().disabled).toBe(true);
  });
});
