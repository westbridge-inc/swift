/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [UI-SWEEP U72] The store's order screen never shows a server code. A
// cancelled order printed its cancellationReason as-is, so a system cancel
// read "FOOD_TOO_OLD" / "NO_DRIVERS_AVAILABLE"; the history read "Rider en
// route pickup"; an MMG order's payment line read "MOBILE_MONEY". The words
// are the ones the web store console uses (@swift/types order-words, web
// lib/vendor-order-view). The REAL VendorOrderDetailScreen on a real React
// renderer; only native drawing, the kit, the order read and the network are
// stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  orders: {} as Record<string, any>,
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
    CodeInput: () => null,
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
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
    orderActions: () => [],
  };
});
vi.mock('../../../hooks/vendorops', () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null });
  return {
    useVendorOrder: (id?: string) => ({ data: id ? fx.orders[id] : undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    useOrderAction: idle, useRetryDispatch: idle, useSetOrderFulfillmentMode: idle, useReturnReceived: idle,
    usePickingActions: () => ({ setPicked: idle(), substitute: idle(), refundLine: idle() }),
    useVendorMenu: () => ({ data: [] }),
  };
});

import { VendorOrderDetailScreen } from './VendorOrderDetailScreen';

const order = (extra: Record<string, unknown>) => ({
  id: 'a', orderNumber: 'A', items: [], statusHistory: [], customer: { firstName: 'Customer' },
  vendor: { vendorType: 'RESTAURANT' }, paymentMethod: 'CASH', fulfillment: 'DELIVERY', ...extra,
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function show(o: Record<string, unknown>) {
  fx.orders = { a: o };
  await act(async () => root.render(React.createElement(VendorOrderDetailScreen, {
    navigation: { goBack: vi.fn(), navigate: vi.fn() }, route: { name: 'VendorOrderDetail', params: { orderId: 'a' } },
  })));
  return host.textContent ?? '';
}

beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[UI-SWEEP U72] the store order screen reads in words', () => {
  it('a system cancel reads as the shared words, never the code', async () => {
    const text = await show(order({ status: 'CANCELLED', cancellationReason: 'FOOD_TOO_OLD' }));
    expect(text).toContain('Too old to deliver: the order was ready but no rider could be found in time.');
    expect(text).not.toContain('FOOD_TOO_OLD');

    const ride = await show(order({ status: 'CANCELLED', cancellationReason: 'NO_DRIVERS_AVAILABLE' }));
    expect(ride).toContain('No driver was found in time.');
    expect(ride).not.toContain('NO_DRIVERS_AVAILABLE');
  });

  it('a code this build does not know reads neutrally, never the code', async () => {
    const text = await show(order({ status: 'CANCELLED', cancellationReason: 'SOME_NEW_SYSTEM_CODE' }));
    expect(text).toContain('No further details are available.');
    expect(text).not.toContain('SOME_NEW_SYSTEM_CODE');
  });

  it('a reason a person typed shows as typed', async () => {
    const text = await show(order({ status: 'CANCELLED', cancellationReason: 'Out of stock' }));
    expect(text).toContain('Out of stock');
  });

  it("the order's history names each status in the store's words", async () => {
    const text = await show(order({
      status: 'CANCELLED',
      statusHistory: [
        { id: '1', status: 'PENDING', createdAt: '2026-10-21T10:00:00Z' },
        { id: '2', status: 'RIDER_EN_ROUTE_PICKUP', createdAt: '2026-10-21T10:05:00Z' },
        { id: '3', status: 'RETURNING', createdAt: '2026-10-21T10:30:00Z' },
      ],
    }));
    expect(text).toContain('Placed');
    expect(text).toContain('Rider en route');
    expect(text).toContain('Returning');
    expect(text).not.toMatch(/RIDER_EN_ROUTE_PICKUP|Rider en route pickup|RETURNING/);
  });

  it("an MMG order's payment line is the web console's sentence, never MOBILE_MONEY", async () => {
    const text = await show(order({ status: 'ACCEPTED', paymentMethod: 'MOBILE_MONEY' }));
    expect(text).toContain('MMG — the customer pays your store’s MMG account.');
    expect(text).not.toContain('MOBILE_MONEY');
  });
});
