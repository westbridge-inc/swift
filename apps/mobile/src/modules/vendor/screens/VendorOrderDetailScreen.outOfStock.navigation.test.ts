/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [STORE-DASH · owner 22 Oct 2026, O-4] On a WAITING order, every store type,
// each item has a one-tap "Out of stock": it asks the customer (continue
// without it, or cancel; server #2043). While the customer answers there is
// no Accept and the screen says why; a line that was asked says what was
// asked. Once the order is accepted the button is gone (today's flow). The
// REAL VendorOrderDetailScreen on a real React renderer; only native drawing,
// the kit, the order read and the network are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  orders: {} as Record<string, any>,
  refund: { mutate: vi.fn(), isPending: false, isError: false, error: null } as any,
  act: { mutate: vi.fn(), isPending: false, isError: false, error: null } as any,
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
    useOrderAction: () => fx.act, useRetryDispatch: idle, useSetOrderFulfillmentMode: idle, useReturnReceived: idle,
    usePickingActions: () => ({ setPicked: idle(), substitute: idle(), refundLine: fx.refund }),
    useVendorMenu: () => ({ data: [] }),
  };
});

import { VendorOrderDetailScreen } from './VendorOrderDetailScreen';

const line = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, itemId: `item-${id}`, name, quantity: 1, totalBase: 1000, subStatus: 'NONE', ...extra });
const order = (extra: Record<string, unknown>) => ({
  id: 'a', orderNumber: 'A', statusHistory: [], customer: { firstName: 'Customer' },
  vendor: { vendorType: 'RESTAURANT' }, paymentMethod: 'CASH', fulfillment: 'DELIVERY',
  items: [line('l1', 'Pepperpot'), line('l2', 'Sorrel')], ...extra,
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
const buttons = (label: string) => [...host.querySelectorAll('button')].filter((b) => b.textContent === label);

beforeEach(() => {
  fx.refund.mutate = vi.fn();
  fx.act.mutate = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[STORE-DASH · O-4] "Out of stock" per item on a waiting order', () => {
  it('a restaurant\'s waiting order: one "Out of stock" per item, one tap asks about THAT item', async () => {
    await show(order({ status: 'PENDING' }));
    expect(buttons('Out of stock')).toHaveLength(2);
    await act(async () => { buttons('Out of stock')[1]!.click(); });
    expect(fx.refund.mutate).toHaveBeenCalledTimes(1);
    expect(fx.refund.mutate).toHaveBeenCalledWith({ orderId: 'a', lineId: 'l2' });
  });

  it('every store type gets it (a shop, a grocery)', async () => {
    for (const vendorType of ['STORE', 'SUPERMARKET']) {
      await show(order({ status: 'PENDING', vendor: { vendorType } }));
      expect(buttons('Out of stock'), vendorType).toHaveLength(2);
    }
  });

  it('while the customer answers: the asked line says what was asked, no button on it, and the screen says why there is no Accept', async () => {
    const text = await show(order({ status: 'PENDING', items: [line('l1', 'Pepperpot', { subStatus: 'PENDING', substituteName: null }), line('l2', 'Sorrel')] }));
    expect(text).toContain('Asked the customer: continue without it, or cancel');
    expect(text).not.toContain('Waiting on the customer: null');
    expect(text).toContain('Waiting on the customer’s answer — accept after they reply.');
    // [REVIEW-F S3-2] Sorrel is now the last item still coming: its step is Reject, not a question.
    expect(buttons('Out of stock')).toHaveLength(0);
    expect(buttons('Out of stock — reject the order')).toHaveLength(1);
  });

  it('every item came off: the screen says to reject with a reason', async () => {
    const text = await show(order({ status: 'PENDING', items: [line('l1', 'Pepperpot', { subStatus: 'REFUNDED' }), line('l2', 'Sorrel', { subStatus: 'REJECTED' })] }));
    expect(text).toContain('Every item is out of stock — reject the order with a reason.');
    expect(buttons('Out of stock')).toHaveLength(0);
  });

  it('control: once accepted there is no "Out of stock" button and no waiting note', async () => {
    const text = await show(order({ status: 'PREPARING' }));
    expect(buttons('Out of stock')).toHaveLength(0);
    expect(text).not.toContain('Waiting on the customer’s answer');
  });
});

describe('[REVIEW-F S3-2 on #2048] the last item out of stock is Reject (out of stock), asked once', () => {
  it('one item left: no customer question; the store is asked once, then the order is rejected as out of stock', async () => {
    await show(order({ status: 'PENDING', items: [line('l1', 'Pepperpot', { subStatus: 'REFUNDED' }), line('l2', 'Sorrel')] }));
    expect(buttons('Out of stock')).toHaveLength(0);
    await act(async () => { buttons('Out of stock — reject the order')[0]!.click(); });
    expect(host.textContent).toContain('This is the last item. Reject the order as out of stock? The customer is told right away.');
    expect(fx.act.mutate).not.toHaveBeenCalled();
    await act(async () => { buttons('Yes, reject')[0]!.click(); });
    expect(fx.act.mutate).toHaveBeenCalledWith({ id: 'a', action: 'reject', reason: 'Out of stock' });
    expect(fx.refund.mutate).not.toHaveBeenCalled();
  });

  it('"Keep it" sends nothing', async () => {
    await show(order({ status: 'PENDING', items: [line('l1', 'Sorrel')] }));
    await act(async () => { buttons('Out of stock — reject the order')[0]!.click(); });
    await act(async () => { buttons('Keep it')[0]!.click(); });
    expect(fx.act.mutate).not.toHaveBeenCalled();
    expect(buttons('Out of stock — reject the order')).toHaveLength(1);
  });
});
