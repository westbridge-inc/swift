/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [STORE-DASH · owner ruling 22 Oct 19:45Z, O-2] The order screen's hand-overs:
//   - takeaway with the store's pickup code OFF: no code box; the screen says
//     to check the customer's first name and the order number, and "Handed to
//     customer" goes in one tap with NO code;
//   - the code ON (or an older server): today's code box, and the button waits
//     for the full code;
//   - a Swift-rider delivery with its rider assigned: the rider's photo, first
//     name and vehicle to check, then "Handed to rider"; once marked, the
//     screen says so; an older server shows nothing new.
// The REAL VendorOrderDetailScreen on a real React renderer; only native
// drawing, the kit, the order read, the step list and the network are stand-ins
// (the step list is the shared statusActions, pinned by the web copy's tests).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  orders: {} as Record<string, any>,
  actions: [] as Array<{ label: string; action: string }>,
  act: { mutate: vi.fn(), isPending: false, isError: false, error: null } as any,
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
    Avatar: (p: any) => h('img', { alt: `Avatar ${p.name ?? ''}`, src: p.uri ?? undefined }),
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress, disabled: p.disabled }, p.label),
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
    prettyStatus: (s?: string) => s ?? '',
    orderActions: () => fx.actions,
  };
});
vi.mock('../../../hooks/vendorops', () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null });
  return {
    useVendorOrder: (id?: string) => ({ data: id ? fx.orders[id] : undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    useOrderAction: () => fx.act, useRetryDispatch: idle, useSetOrderFulfillmentMode: idle, useReturnReceived: idle,
    usePickingActions: () => ({ setPicked: idle(), substitute: idle(), refundLine: idle() }),
    useVendorMenu: () => ({ data: [] }),
  };
});

import { VendorOrderDetailScreen } from './VendorOrderDetailScreen';

const rider = { user: { firstName: 'Devon', lastName: 'R', phone: null }, vehicleMake: 'Honda', vehicleModel: 'CG125', vehicleColor: 'Red', licensePlate: 'PAB 1234', photoUrl: 'https://cdn.test/signed/rider.jpg?sig=1' };
const order = (extra: Record<string, unknown>) => ({
  id: 'a', orderNumber: 'SW-1001', statusHistory: [], customer: { firstName: 'Asha' },
  vendor: { vendorType: 'RESTAURANT' }, paymentMethod: 'CASH', items: [], ...extra,
});
const takeaway = (extra: Record<string, unknown> = {}) => order({ status: 'READY_FOR_PICKUP', fulfillment: 'PICKUP', ...extra });
const riderDelivery = (extra: Record<string, unknown> = {}) => order({
  status: 'RIDER_ARRIVED_PICKUP', fulfillment: 'DELIVERY', fulfillmentMode: 'PLATFORM_RIDER', riderId: 'r-1', rider,
  preparingAt: '2026-10-23T09:00:00.000Z', readyAt: '2026-10-23T09:10:00.000Z', handedToRiderAt: null, ...extra,
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function show(o: Record<string, unknown>, actions: Array<{ label: string; action: string }>) {
  fx.orders = { a: o };
  fx.actions = actions;
  await act(async () => root.render(React.createElement(VendorOrderDetailScreen, {
    navigation: { goBack: vi.fn(), navigate: vi.fn() }, route: { name: 'VendorOrderDetail', params: { orderId: 'a' } },
  })));
  return host.textContent ?? '';
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const CHECK_NAME = 'Check the name before you hand it over: Asha · order #SW-1001';

beforeEach(() => {
  fx.act.mutate = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[O-2] takeaway: "Handed to customer" with the store\'s pickup code off', () => {
  it('no code box; the screen says to check the name and the order number', async () => {
    const text = await show(takeaway({ pickupCodeRequired: false }), [{ label: 'Handed to customer', action: 'handed-to-customer' }]);
    expect(text).toContain(CHECK_NAME);
    expect(host.querySelector('input[aria-label="Pickup code"]')).toBeNull();
  });

  it('one tap sends the hand-over with NO code (the button does not wait for one)', async () => {
    await show(takeaway({ pickupCodeRequired: false }), [{ label: 'Handed to customer', action: 'handed-to-customer' }]);
    expect(button('Handed to customer')!.disabled).toBe(false);
    await act(async () => { button('Handed to customer')!.click(); });
    expect(fx.act.mutate).toHaveBeenCalledTimes(1);
    expect(fx.act.mutate).toHaveBeenCalledWith({ id: 'a', action: 'handed-to-customer' });
  });

  it('control: the code on — today\'s code box, no name check, the button waits for the full code', async () => {
    const text = await show(takeaway({ pickupCodeRequired: true }), [{ label: 'Mark picked up', action: 'complete-pickup' }]);
    expect(host.querySelector('input[aria-label="Pickup code"]')).not.toBeNull();
    expect(text).not.toContain('Check the name before you hand it over');
    expect(button('Mark picked up')!.disabled).toBe(true);
  });

  it('control: an older server (no pickupCodeRequired) keeps the code box', async () => {
    const text = await show(takeaway(), [{ label: 'Mark picked up', action: 'complete-pickup' }]);
    expect(host.querySelector('input[aria-label="Pickup code"]')).not.toBeNull();
    expect(text).not.toContain('Check the name before you hand it over');
  });
});

describe('[O-2] delivery: "Handed to rider"', () => {
  it('the rider to check: photo, first name and vehicle; one tap records the hand-over', async () => {
    const text = await show(riderDelivery(), [{ label: 'Handed to rider', action: 'handed-to-rider' }]);
    expect(text).toContain('Check the rider before you hand it over:');
    expect(text).toContain('Devon — Red Honda CG125 · PAB 1234');
    expect(host.querySelector('img[src="https://cdn.test/signed/rider.jpg?sig=1"]')).not.toBeNull();
    await act(async () => { button('Handed to rider')!.click(); });
    expect(fx.act.mutate).toHaveBeenCalledWith({ id: 'a', action: 'handed-to-rider' });
  });

  it('once marked: the screen says it went, and the check is gone', async () => {
    const text = await show(riderDelivery({ handedToRiderAt: '2026-10-23T09:15:00.000Z' }), []);
    expect(text).toContain('Handed to the rider');
    expect(text).not.toContain('Check the rider before you hand it over:');
  });

  it('control: an older server (no handedToRiderAt field) shows nothing new', async () => {
    const old: Record<string, unknown> = riderDelivery();
    delete old['handedToRiderAt'];
    const text = await show(old, []);
    expect(text).not.toContain('Check the rider before you hand it over:');
    expect(text).not.toContain('Handed to the rider');
  });

  it('control: no rider yet — no rider check', async () => {
    const text = await show(riderDelivery({ status: 'READY_FOR_PICKUP', riderId: null, rider: null }), []);
    expect(text).not.toContain('Check the rider before you hand it over:');
  });
});

describe('[REVIEW-F S3-1/S4-1 on #2054] no hand-over prompt where there is no hand-over step', () => {
  const paused = { paymentMethod: 'MOBILE_MONEY', mmgClaimMismatchAt: '2026-10-23T09:05:00.000Z' };

  it('a rider delivery paused for an MMG payment review (only Reject survives): no rider check', async () => {
    const text = await show(riderDelivery(paused), []);
    expect(text).not.toContain('Check the rider before you hand it over:');
    expect(host.querySelector('img[src="https://cdn.test/signed/rider.jpg?sig=1"]')).toBeNull();
  });

  it('a takeaway with the code off, paused: no name check (and no code box)', async () => {
    const text = await show(takeaway({ pickupCodeRequired: false, ...paused }), []);
    expect(text).not.toContain('Check the name before you hand it over');
    expect(text).not.toContain('HANDOVER CHECK');
    expect(host.querySelector('input[aria-label="Pickup code"]')).toBeNull();
  });

  it('the rider is assigned but the order is not ready yet ("Ready for delivery"): no rider check', async () => {
    const text = await show(riderDelivery({ status: 'RIDER_ASSIGNED', readyAt: null }), [{ label: 'Ready for delivery', action: 'ready' }]);
    expect(text).not.toContain('Check the rider before you hand it over:');
  });
});
