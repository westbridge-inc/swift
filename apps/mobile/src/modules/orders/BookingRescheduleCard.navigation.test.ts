/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';

// [BOOK-S6a · owner B2] The customer's "Change time" renders what the server projected and shows
// the server's own words for a refusal. The transport hooks are stand-ins; the card is real.
const fx = vi.hoisted(() => ({
  move: vi.fn(),
  pending: false,
  slots: { data: { slots: [] as string[], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6] }, isPending: false, isError: false, refetch: () => undefined } as Record<string, unknown>,
  slotsAsked: [] as Array<[string, string]>,
}));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  return { View: Box, ScrollView: Box };
});
vi.mock('../../kit', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  const Button = (p: any) => h('button', { disabled: p.disabled || p.loading, onClick: p.onPress, 'data-selected': p.selected ? 'yes' : 'no' }, p.label);
  return { T: Box, PillButton: Button, Chip: Button };
});
vi.mock('../../hooks/customer', () => ({
  useItemSlots: (itemId: string, day: string) => { fx.slotsAsked.push([itemId, day]); return fx.slots; },
  useRescheduleBooking: () => ({ mutate: fx.move, isPending: fx.pending }),
}));

import { BookingRescheduleCard } from './BookingRescheduleCard';
import type { AppointmentBookingView } from '../../lib/appointmentBooking';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove(); root = undefined; fx.move.mockReset(); fx.pending = false; fx.slotsAsked = [];
  fx.slots = { data: { slots: [], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6] }, isPending: false, isError: false, refetch: () => undefined };
});

const CURRENT = '2026-12-01T14:00:00.000Z'; // 10:00 AM in Guyana
const OTHER = '2026-12-01T16:00:00.000Z'; // 12:00 PM in Guyana
const view = (over: Partial<AppointmentBookingView> = {}): AppointmentBookingView => ({
  bookingId: 'b-1', itemId: 'item-1', slotStart: CURRENT, canReschedule: true, rescheduleUnavailable: null, ...over,
});
async function render(booking: AppointmentBookingView) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(BookingRescheduleCard, { orderId: 'o-1', booking })));
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);

describe('[BOOK-S6a] Change time on a booking', () => {
  it('the server refuses a move now: its words, and no control', async () => {
    await render(view({ canReschedule: false, rescheduleUnavailable: 'This booking can no longer be moved in the app: it starts in less than 2 hours. Contact the provider to change it.' }));
    expect(host.textContent).toBe('This booking can no longer be moved in the app: it starts in less than 2 hours. Contact the provider to change it.');
    expect(button('Change time')).toBeUndefined();
  });

  it('the server says nothing: nothing is shown', async () => {
    await render(view({ canReschedule: false, rescheduleUnavailable: null }));
    expect(host.textContent).toBe('');
  });

  it('allowed: the same service\'s free times (not the booked one), and the move the server is asked for', async () => {
    fx.slots = { ...fx.slots, data: { slots: [CURRENT, OTHER], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6] } };
    await render(view());
    // Closed: no slot read is made until the customer asks.
    expect(fx.slotsAsked.every(([itemId]) => itemId === '')).toBe(true);
    await act(async () => button('Change time')!.click());
    expect(fx.slotsAsked.at(-1)![0]).toBe('item-1');
    expect(button('10:00 AM')).toBeUndefined();
    expect(button('Pick a new time')!.disabled).toBe(true);
    await act(async () => button('12:00 PM')!.click());
    const confirm = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Move to '))!;
    expect(confirm.textContent).toContain('12:00 PM');
    await act(async () => confirm.click());
    expect(fx.move).toHaveBeenCalledOnce();
    expect(fx.move.mock.calls[0]![0]).toEqual({ orderId: 'o-1', bookingId: 'b-1', newSlotStart: OTHER });
  });

  it('a refused move (time taken, cut-off) shows the server\'s message', async () => {
    fx.slots = { ...fx.slots, data: { slots: [OTHER], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6] } };
    fx.move.mockImplementation((_v: unknown, opts: { onError: (e: unknown) => void }) => opts.onError({ response: { data: { error: { message: 'That time was just booked by someone else.' } } } }));
    await render(view());
    await act(async () => button('Change time')!.click());
    await act(async () => button('12:00 PM')!.click());
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Move to '))!.click());
    expect(host.textContent).toContain('That time was just booked by someone else.');
    // The refused time is let go: the customer picks again.
    expect(button('Pick a new time')!.disabled).toBe(true);
  });

  it('a failed read of the times is an error with a retry, never "no times"', async () => {
    fx.slots = { data: undefined, isPending: false, isError: true, refetch: () => undefined };
    await render(view());
    await act(async () => button('Change time')!.click());
    expect(host.textContent).toContain('Couldn’t load available times.');
    expect(host.textContent).not.toContain('No other times');
  });

  it('while the move is sending, the confirm button holds', async () => {
    fx.pending = true;
    fx.slots = { ...fx.slots, data: { slots: [OTHER], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6] } };
    await render(view());
    await act(async () => button('Change time')!.click());
    await act(async () => button('12:00 PM')!.click());
    expect([...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Move to '))!.disabled).toBe(true);
  });
});
