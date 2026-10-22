/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [UI-SWEEP, phone twin of web #2013] The store's Schedule never reads a
// failure as a fact, and never loses a refusal:
//   - a failed blocked-time read showed the day as "No bookings this day"
//     (the day may be blocked) — it now says it could not check;
//   - "Block time" closed on ANY answer, so a refused block vanished without
//     a word — the popup now stays open with the refusal;
//   - a refused unblock was silent — it is now said.
// The REAL VendorScheduleScreen over REAL TanStack queries and mutations;
// only native drawing, the kit and the network are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  bookings: vi.fn(),
  exceptions: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
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
  };
});

import { VendorScheduleScreen } from './VendorScheduleScreen';
import { appointmentDayKey } from '../../../lib/appointmentTime';

const refusal = (message: string) => Object.assign(new Error('Request failed'), { response: { data: { error: { message } } } });

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const text = () => host.textContent ?? '';
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label);
async function render() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(VendorScheduleScreen, { navigation: { navigate: vi.fn() } }))));
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.bookings.mockResolvedValue([]);
  fx.exceptions.mockResolvedValue([]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe('[UI-SWEEP, web #2013 twin] the store Schedule says what failed', () => {
  it('a failed blocked-time read says it could not check, never "No bookings this day"', async () => {
    fx.exceptions.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
    await render();
    expect(text()).toContain("We couldn't load your blocked time");
    expect(text()).not.toContain('No bookings this day');
    await act(async () => { button('Try again')!.click(); });
    await settle();
    expect(fx.exceptions).toHaveBeenCalledTimes(2);
    expect(text()).toContain('No bookings this day');
  });

  it('a refused block keeps the popup open with the refusal; reopening starts clean; a saved block closes it', async () => {
    fx.create.mockRejectedValueOnce(refusal('That time overlaps a booking.')).mockResolvedValue({ id: 'x-1' });
    await render();
    await act(async () => { button('Block time')!.click(); });
    const blockButton = () => host.querySelector<HTMLButtonElement>('[role="dialog"] button[data-pill="Block time"]')!;
    await act(async () => { blockButton().click(); });
    await settle();
    expect(host.querySelector('[role="dialog"]'), 'the popup stays open').not.toBeNull();
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain('That time overlaps a booking.');

    await act(async () => { button('Cancel')!.click(); });
    await act(async () => { button('Block time')!.click(); });
    expect(host.querySelector('[role="dialog"]')!.textContent, 'the old refusal is gone').not.toContain('That time overlaps a booking.');

    await act(async () => { blockButton().click(); });
    await settle();
    expect(host.querySelector('[role="dialog"]'), 'a saved block closes the popup').toBeNull();
    expect(fx.create).toHaveBeenCalledTimes(2);
  });

  it('a refused unblock is said; the remove control names the block', async () => {
    fx.exceptions.mockResolvedValue([{ id: 'b-1', date: `${appointmentDayKey(new Date())}T00:00:00.000Z`, start: '13:00', end: '17:00', reason: null }]);
    fx.remove.mockRejectedValueOnce(refusal('Only the owner can unblock time.'));
    await render();
    const remove = button('Remove block, 13:00–17:00');
    expect(remove, 'the remove control names the block').toBeDefined();
    await act(async () => { remove!.click(); });
    await settle();
    expect(text()).toContain('Only the owner can unblock time.');
    expect(text()).toContain('Blocked · 13:00–17:00');
  });
});
