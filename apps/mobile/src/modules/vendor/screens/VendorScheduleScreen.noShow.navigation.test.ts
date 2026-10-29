/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [BOOK-NS-APP · owner B3] "Customer didn't come" on the store's Schedule:
//   - on a confirmed booking (its order accepted) whose time has started, tied to an order; never on a reserved,
//     completed, not-yet-started or order-less booking (a booking from an older server without orderId included);
//   - one confirm step, then the server's answer: its refusal words, or the closed state from its answer;
//   - the Schedule is read again after the answer (the closed booking leaves the day).
// The REAL VendorScheduleScreen and NoShowConfirm over REAL TanStack queries and mutations; only native drawing,
// the kit and the network are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  bookings: vi.fn(),
  exceptions: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  menu: vi.fn(),
  moveTimes: vi.fn(),
  move: vi.fn(),
  noShow: vi.fn(),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const kids = (p: any) => (typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View: (p: any) => h('div', null, kids(p)),
    ScrollView: (p: any) => h('div', null, kids(p)),
    Pressable: (p: any) => h('button', { type: 'button', 'aria-label': p.accessibilityLabel, disabled: !!p.disabled, onClick: p.onPress }, kids(p)),
    RefreshControl: () => null,
  };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, space: fx.token }));
vi.mock('../../../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }) }));
vi.mock('../../../kit/controls', () => ({ BrandSwitch: () => null }));
vi.mock('../shared', async () => {
  const R = await import('react');
  return {
    GUTTER: 16,
    SubHeader: (p: any) => R.createElement('header', null, R.createElement('button', { type: 'button', onClick: p.action?.onPress }, p.action?.label)),
  };
});
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  return {
    Screen: Box, Card: Box, LoadingBlock: () => h('div', null, 'Loading'),
    IconChip: () => null,
    T: (p: any) => h('span', null, p.children), PopupTitle: (p: any) => h('h2', null, p.children), TonePill: (p: any) => h('span', null, p.label),
    Chip: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
    PillButton: (p: any) => h('button', { type: 'button', 'data-pill': p.label, disabled: !!p.disabled, onClick: p.onPress }, p.label),
    LinkText: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
    LabeledInput: (p: any) => h('input', { 'aria-label': p.label, value: p.value, onChange: (e: any) => p.onChangeText(e.target.value) }),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    EmptyState: (p: any) => h('section', null, p.title),
    ErrorState: (p: any) => h('section', { role: 'alert' }, p.message, h('button', { type: 'button', onClick: p.onRetry }, 'Try again')),
  };
});
// The screen's own hooks, as real TanStack reads and writes over a stand-in network.
vi.mock('../../../hooks/vendorops', async () => {
  const { useMutation, useQuery, useQueryClient } = await import('@tanstack/react-query');
  const after = (qc: ReturnType<typeof useQueryClient>) => () => { void qc.invalidateQueries({ queryKey: ['vendor'] }); };
  return {
    useVendorBookings: () => useQuery({ queryKey: ['vendor', 'bookings'], queryFn: () => fx.bookings() }),
    useVendorBookingExceptions: () => useQuery({ queryKey: ['vendor', 'booking-exceptions'], queryFn: () => fx.exceptions() }),
    useCreateBookingException: () => { const qc = useQueryClient(); return useMutation({ mutationFn: (v: unknown) => fx.create(v), onSuccess: after(qc) }); },
    useDeleteBookingException: () => { const qc = useQueryClient(); return useMutation({ mutationFn: (id: string) => fx.remove(id), onSuccess: after(qc) }); },
    useVendorMenu: () => useQuery({ queryKey: ['vendor', 'menu'], queryFn: () => fx.menu() }),
    // [BOOK-S5a] "Move": the listing's free times and the business's move.
    useBookingMoveTimes: (itemId: string, date: string) => useQuery({ queryKey: ['vendor', 'move-times', itemId, date], queryFn: () => fx.moveTimes(itemId, date) }),
    useRescheduleVendorBooking: () => { const qc = useQueryClient(); return useMutation({ mutationFn: (v: unknown) => fx.move(v), onSettled: after(qc) }); },
    // [BOOK-NS-APP] The real mutation's shape (the hook itself is pinned in hooks/vendorops.noShow.test.ts).
    useMarkNoShow: () => { const qc = useQueryClient(); return useMutation({ mutationFn: (id: string) => fx.noShow(id), onSettled: after(qc) }); },
  };
});

import { VendorScheduleScreen } from './VendorScheduleScreen';

const NOW = Date.parse('2026-10-29T15:00:00.000Z'); // 11:00 in Guyana: the bookings below are all "Today"
const MIN = 60_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();
const booking = (extra: Record<string, unknown> = {}) => ({
  id: 'b-1', serviceName: 'Haircut', price: 2000, slotStart: at(-15 * MIN), slotEnd: at(15 * MIN),
  status: 'CONFIRMED', orderId: 'o-1', customer: { firstName: 'Asha' }, itemId: 'item-1', noShow: { allowed: true }, ...extra,
});
const refusal = (code: string, message: string) => Object.assign(new Error('Request failed with status code 409'), {
  response: { status: 409, data: { success: false, error: { code, message } } },
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const dialog = () => host.querySelector('[role="dialog"]');
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label);
const NO_SHOW = 'Customer didn’t come';
async function render(rows: unknown[]) {
  fx.bookings.mockResolvedValue(rows);
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(VendorScheduleScreen, { navigation: { navigate: vi.fn() } }))));
  await settle();
}
async function tap(label: string) {
  const b = button(label);
  expect(b, label).toBeTruthy();
  await act(async () => { b!.click(); });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fx.exceptions.mockResolvedValue([]);
  fx.menu.mockResolvedValue([]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.useRealTimers();
});

describe('[BOOK-NS-APP] which Schedule bookings offer "Customer didn\'t come"', () => {
  it('a confirmed booking whose time has started, with its order: yes (and no Move: it has started)', async () => {
    await render([booking()]);
    expect(button(NO_SHOW)).toBeTruthy();
    expect(button('Move')).toBeUndefined();
  });

  it('from the start itself', async () => {
    await render([booking({ slotStart: at(0) })]);
    expect(button(NO_SHOW)).toBeTruthy();
  });

  it('not yet started: Move, no "Customer didn\'t come"', async () => {
    await render([booking({ slotStart: at(30 * MIN), slotEnd: at(60 * MIN) })]);
    expect(button(NO_SHOW)).toBeUndefined();
    expect(button('Move')).toBeTruthy();
  });

  it('[REVIEW-F S3-1 on #2201] an older server (no noShow word) or the server saying no: no button', async () => {
    await render([booking({ id: 'b-old', noShow: undefined }), booking({ id: 'b-no', orderId: 'o-2', noShow: { allowed: false } })]);
    expect(host.textContent).toContain('Haircut');
    expect(button(NO_SHOW)).toBeUndefined();
  });

  it('at the start the Schedule is read again, and the link appears with the server\'s new word', async () => {
    const soon = booking({ slotStart: at(200), slotEnd: at(30 * MIN), noShow: { allowed: false } });
    await render([soon]);
    expect(button(NO_SHOW)).toBeUndefined();
    const reads = fx.bookings.mock.calls.length;
    fx.bookings.mockResolvedValue([{ ...soon, noShow: { allowed: true } }]);
    vi.setSystemTime(NOW + 300); // the device clock passes the start; the card's timer fires on its own
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    await settle();
    expect(fx.bookings.mock.calls.length, 'read again at the start').toBeGreaterThan(reads);
    expect(button(NO_SHOW)).toBeTruthy();
  });

  it('a reserved (not accepted) or completed booking, or one without an order: no button', async () => {
    await render([
      booking({ id: 'b-r', status: 'RESERVED', orderId: 'o-r' }),
      booking({ id: 'b-c', status: 'COMPLETED', orderId: 'o-c' }),
      booking({ id: 'b-n', orderId: null }),
    ]);
    expect(host.textContent).toContain('Haircut');
    expect(button(NO_SHOW)).toBeUndefined();
  });

  it('an older server\'s booking (no orderId, no itemId): no button, no Move, nothing breaks', async () => {
    // The row an older server sends: no orderId, no itemId, no noShow word.
    const old = { id: 'b-1', serviceName: 'Haircut', price: 2000, slotStart: at(-15 * MIN), slotEnd: at(15 * MIN), status: 'CONFIRMED', customer: { firstName: 'Asha' } };
    await render([old]);
    expect(host.textContent).toContain('Haircut');
    expect(button(NO_SHOW)).toBeUndefined();
    expect(button('Move')).toBeUndefined();
  });
});

describe('[BOOK-NS-APP] one confirm step, then the server\'s answer', () => {
  it('asks first; "Keep the booking" sends nothing', async () => {
    await render([booking()]);
    await tap(NO_SHOW);
    expect(dialog()!.textContent).toContain('Mark as ‘Customer didn’t come’?');
    expect(dialog()!.textContent).toContain('The booking closes. No fee, no strike.');
    await tap('Keep the booking');
    expect(dialog()).toBeNull();
    expect(fx.noShow).not.toHaveBeenCalled();
  });

  it('"Yes" closes the booking\'s ORDER once; the closed state is the server\'s answer; the Schedule is read again', async () => {
    fx.noShow.mockResolvedValue({ id: 'o-1', status: 'CANCELLED', appointmentNoShow: { bookingId: 'b-1', recordedAt: '2026-10-29T14:58:00.000Z' } });
    await render([booking()]);
    const reads = fx.bookings.mock.calls.length;
    fx.bookings.mockResolvedValue([]); // the server drops a cancelled booking from the Schedule
    await tap(NO_SHOW);
    await tap('Yes, they didn’t come');
    expect(fx.noShow).toHaveBeenCalledTimes(1);
    expect(fx.noShow).toHaveBeenCalledWith('o-1');
    expect(dialog()!.textContent).toContain('Booking closed');
    expect(dialog()!.textContent).toContain('Recorded at 10:58 AM: the customer didn’t come. No fee, no strike.');
    expect(fx.bookings.mock.calls.length).toBeGreaterThan(reads);
    await tap('Done');
    expect(dialog()).toBeNull();
    expect(button(NO_SHOW)).toBeUndefined();
  });

  it('a refusal stays on the popup in the server\'s own words', async () => {
    const words = 'This booking is already paid by MMG, so it cannot be closed here. Settle it with the customer directly, or contact Swift Support.';
    fx.noShow.mockRejectedValue(refusal('NO_SHOW_PAID_MMG', words));
    await render([booking()]);
    await tap(NO_SHOW);
    await tap('Yes, they didn’t come');
    expect(dialog()!.textContent).toContain(words);
    expect(dialog()!.textContent).not.toContain('Booking closed');
    expect(host.textContent).not.toContain('NO_SHOW_PAID_MMG');
  });
});
