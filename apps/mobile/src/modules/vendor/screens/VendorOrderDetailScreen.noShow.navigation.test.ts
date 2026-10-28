/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [BOOK-NS-APP · owner B3] "Customer didn't come" on the store's order screen, beside "Mark complete":
//   - only on an accepted appointment whose time has started (and it appears at the start on an open screen);
//   - one confirm step: "Mark as 'Customer didn't come'? The booking closes. No fee, no strike." Nothing is sent
//     before "Yes"; "Keep the booking" sends nothing;
//   - a refusal stays on the popup in the server's own words;
//   - on success, the closed state from the server's answer (an answer without the record still reads closed).
// The REAL VendorOrderDetailScreen and NoShowConfirm over a REAL TanStack mutation; only native drawing, the kit,
// the order read, the step list and the network are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  orders: {} as Record<string, any>,
  actions: [] as Array<{ label: string; action: string }>,
  act: { mutate: () => undefined, isPending: false, isError: false, error: null } as any,
  noShow: (_id: string): Promise<unknown> => Promise.resolve(undefined),
  sent: [] as string[],
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
    useVendorOrder: (id?: string) => ({ data: id ? fx.orders[id] : undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    useOrderAction: () => fx.act, useRetryDispatch: idle, useSetOrderFulfillmentMode: idle, useReturnReceived: idle,
    usePickingActions: () => ({ setPicked: idle(), substitute: idle(), refundLine: idle() }),
    usePendingPickLines: () => new Set(),
    useVendorMenu: () => ({ data: [] }),
    // The real mutation's shape: the network is fx.noShow (the hook itself is pinned in hooks/vendorops.noShow.test.ts).
    useMarkNoShow: () => useMutation({ mutationFn: (id: string) => { fx.sent.push(id); return fx.noShow(id); } }),
  };
});

import { VendorOrderDetailScreen } from './VendorOrderDetailScreen';

const NOW = Date.parse('2026-10-29T15:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();
const appt = (extra: Record<string, unknown> = {}) => ({
  id: 'a', orderNumber: 'SW-2001', statusHistory: [], customer: { firstName: 'Asha' }, vendor: { vendorType: 'SERVICE' },
  paymentMethod: 'CASH', items: [], fulfillment: 'APPOINTMENT', status: 'ACCEPTED', appointmentSlot: at(-10 * MIN), ...extra,
});
const COMPLETE = [{ label: 'Mark complete', action: 'complete-appointment' }];
const refusal = (code: string, message: string) => Object.assign(new Error('Request failed with status code 409'), {
  response: { status: 409, data: { success: false, error: { code, message } } },
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
/** Real timers: let the answer land. The start-clock case fakes setTimeout, so it waits on microtasks only. */
let timeoutsFaked = false;
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await (timeoutsFaked ? Promise.resolve() : new Promise((r) => setTimeout(r, 1))); });
};
const text = () => host.textContent ?? '';
const dialog = () => host.querySelector('[role="dialog"]');
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
async function show(o: Record<string, unknown>, actions = COMPLETE) {
  fx.orders = { a: o };
  fx.actions = actions;
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fx.sent = [];
  fx.noShow = () => Promise.resolve(undefined);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.useRealTimers();
  timeoutsFaked = false;
});

describe('[BOOK-NS-APP] where "Customer didn\'t come" shows on the order screen', () => {
  it('an accepted appointment whose time has started: beside "Mark complete"', async () => {
    await show(appt());
    expect(button('Mark complete')).toBeTruthy();
    expect(button('Customer didn’t come')).toBeTruthy();
    expect(dialog(), 'nothing asked before the tap').toBeNull();
  });

  it('from the start itself; not one minute before', async () => {
    await show(appt({ appointmentSlot: at(0) }));
    expect(button('Customer didn’t come')).toBeTruthy();
    await show(appt({ appointmentSlot: at(MIN) }));
    expect(button('Mark complete')).toBeTruthy();
    expect(button('Customer didn’t come')).toBeUndefined();
  });

  it('not on a waiting, completed or cancelled appointment, nor on a takeaway', async () => {
    for (const status of ['PENDING', 'COMPLETED', 'CANCELLED']) {
      await show(appt({ status }), []);
      expect(button('Customer didn’t come'), status).toBeUndefined();
    }
    await show(appt({ fulfillment: 'PICKUP', status: 'ACCEPTED' }), []);
    expect(button('Customer didn’t come')).toBeUndefined();
  });

  it('an appointment with no time on it (an odd or older record): no button', async () => {
    await show(appt({ appointmentSlot: null }));
    expect(button('Customer didn’t come')).toBeUndefined();
  });

  it('an MMG order paused for a payment review: no button', async () => {
    await show(appt({ paymentMethod: 'MOBILE_MONEY', mmgClaimMismatchAt: at(-60 * MIN) }), []);
    expect(button('Customer didn’t come')).toBeUndefined();
  });

  it('on its own: the bar shows the button even when no other step is offered', async () => {
    await show(appt(), []);
    expect(button('Customer didn’t come')).toBeTruthy();
  });
});

describe('[BOOK-NS-APP] the screen left open across the start', () => {
  it('the button appears at the start without a new read of the order', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    timeoutsFaked = true;
    vi.setSystemTime(NOW);
    await show(appt({ appointmentSlot: at(90_000) }));
    expect(button('Customer didn’t come')).toBeUndefined();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(button('Customer didn’t come'), 'not yet').toBeUndefined();
    await act(async () => { vi.advanceTimersByTime(31_000); });
    expect(button('Customer didn’t come'), 'at the start').toBeTruthy();
  });
});

describe('[BOOK-NS-APP] one confirm step, then the server\'s answer', () => {
  it('the tap asks first, in the owner\'s words; nothing is sent; "Keep the booking" sends nothing', async () => {
    await show(appt());
    await tap('Customer didn’t come');
    expect(dialog()!.textContent).toContain('Mark as ‘Customer didn’t come’?');
    expect(dialog()!.textContent).toContain('The booking closes. No fee, no strike.');
    expect(fx.sent).toEqual([]);
    await tap('Keep the booking');
    expect(dialog()).toBeNull();
    expect(fx.sent).toEqual([]);
  });

  it('"Yes" sends it once for this order; the closed state is the server\'s answer (when it was recorded)', async () => {
    fx.noShow = () => Promise.resolve({ id: 'a', status: 'CANCELLED', appointmentNoShow: { bookingId: 'b-1', recordedAt: '2026-10-29T14:52:00.000Z' } });
    await show(appt());
    await tap('Customer didn’t come');
    await tap('Yes, they didn’t come');
    expect(fx.sent).toEqual(['a']);
    expect(dialog()!.textContent).toContain('Booking closed');
    expect(dialog()!.textContent).toContain('Recorded at 10:52 AM: the customer didn’t come. No fee, no strike.');
    expect(button('Yes, they didn’t come'), 'no second send from the closed state').toBeUndefined();
    await tap('Done');
    expect(dialog()).toBeNull();
  });

  it('an answer without the record (an older shape) still reads as closed, with no time', async () => {
    fx.noShow = () => Promise.resolve({ id: 'a', status: 'CANCELLED' });
    await show(appt());
    await tap('Customer didn’t come');
    await tap('Yes, they didn’t come');
    expect(dialog()!.textContent).toContain('Recorded: the customer didn’t come. No fee, no strike.');
  });

  it.each([
    ['APPOINTMENT_NOT_STARTED', 'You can mark "Customer didn\'t come" once the appointment\'s time has started.'],
    ['NO_SHOW_NOT_OPEN', 'This appointment can no longer be marked as "Customer didn\'t come".'],
    ['NO_SHOW_PAID_MMG', 'This booking is already paid by MMG, so it cannot be closed here. Settle it with the customer directly, or contact Swift Support.'],
  ])('a refusal (%s) stays on the popup in the server\'s own words; nothing reads as closed', async (code, message) => {
    fx.noShow = () => Promise.reject(refusal(code, message));
    await show(appt());
    await tap('Customer didn’t come');
    await tap('Yes, they didn’t come');
    expect(dialog()!.textContent).toContain(message);
    expect(dialog()!.textContent).not.toContain('Booking closed');
    expect(text()).not.toContain(code);
    // Closing and asking again starts clean.
    await tap('Keep the booking');
    await tap('Customer didn’t come');
    expect(dialog()!.textContent).not.toContain(message);
  });
});
