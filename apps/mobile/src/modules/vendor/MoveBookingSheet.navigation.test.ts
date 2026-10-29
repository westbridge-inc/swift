/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';

// [BOOK-S5a · owner B2] The Schedule's "Move": the server's free times of the same service, the move
// the server is asked for, and its refusal in its words. The transport hooks are stand-ins.
const fx = vi.hoisted(() => ({
  move: vi.fn(),
  reset: vi.fn(),
  pending: false,
  error: null as unknown,
  slots: { data: { slots: [] as string[], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6] }, isPending: false, isError: false, refetch: () => undefined } as Record<string, unknown>,
  asked: [] as Array<[string, string]>,
}));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  return { View: Box, ScrollView: Box };
});
vi.mock('../../kit', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  const Button = (p: any) => h('button', { disabled: p.disabled || p.loading, onClick: p.onPress }, p.label);
  return { T: Box, PopupTitle: Box, PillButton: Button, Chip: Button, LinkText: Button, PopupCard: (p: any) => (p.visible ? h('div', null, p.children) : null) };
});
vi.mock('../../hooks/vendorops', () => ({
  useBookingMoveTimes: (itemId: string, day: string) => { fx.asked.push([itemId, day]); return fx.slots; },
  useRescheduleVendorBooking: () => ({ mutate: fx.move, reset: fx.reset, isPending: fx.pending, isError: fx.error != null, error: fx.error }),
}));

import { MoveBookingSheet, bookingMovable } from './MoveBookingSheet';
import type { VendorBooking } from '../../hooks/vendorops';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined; fx.move.mockReset(); fx.reset.mockReset(); fx.pending = false; fx.error = null; fx.asked = [];
  fx.slots = { data: { slots: [], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6] }, isPending: false, isError: false, refetch: () => undefined };
});

const CURRENT = '2026-12-01T14:00:00.000Z'; // 10:00 AM in Guyana
const OTHER = '2026-12-01T16:00:00.000Z'; // 12:00 PM in Guyana
const booking = (over: Partial<VendorBooking> = {}): VendorBooking => ({
  id: 'b-1', serviceName: 'Cut', price: 2000, slotStart: CURRENT, slotEnd: '2026-12-01T15:00:00.000Z', status: 'CONFIRMED', orderId: 'o-1', customer: { firstName: 'Ada' }, itemId: 'item-1', ...over,
});
async function render(b: VendorBooking | null, onClose = vi.fn()) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(MoveBookingSheet, { booking: b, onClose })));
  return onClose;
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const moveButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Move to ') || b.textContent === 'Pick a new time')!;

describe('[BOOK-S5a] which bookings can be moved', () => {
  const later = Date.parse('2026-11-30T00:00:00.000Z');
  it('a reserved or confirmed booking that has not started, whose listing the server named', () => {
    expect(bookingMovable(booking(), later)).toBe(true);
    expect(bookingMovable(booking({ status: 'RESERVED' }), later)).toBe(true);
  });
  it('not a completed one, not one that started, not when an older server sends no listing', () => {
    expect(bookingMovable(booking({ status: 'COMPLETED' }), later)).toBe(false);
    expect(bookingMovable(booking(), Date.parse(CURRENT) + 1)).toBe(false);
    expect(bookingMovable(booking({ itemId: undefined }), later)).toBe(false);
    expect(bookingMovable(booking({ itemId: '' }), later)).toBe(false);
  });
});

describe('[BOOK-S5a] Move this booking', () => {
  it('closed when no booking is chosen', async () => {
    await render(null);
    expect(host.textContent).toBe('');
  });

  it('the same service\'s free times without the booked one; the move asked for is this booking to the chosen time', async () => {
    fx.slots = { ...fx.slots, data: { slots: [CURRENT, OTHER], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6] } };
    fx.move.mockImplementation((_v: unknown, opts: { onSuccess: () => void }) => opts.onSuccess());
    const onClose = await render(booking());
    expect(fx.asked.at(-1)![0]).toBe('item-1');
    expect(button('10:00 AM')).toBeUndefined();
    expect(moveButton().disabled).toBe(true);
    await act(async () => button('12:00 PM')!.click());
    expect(moveButton().textContent).toContain('12:00 PM');
    await act(async () => moveButton().click());
    expect(fx.move.mock.calls[0]![0]).toEqual({ bookingId: 'b-1', newSlotStart: OTHER });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('a refused move stays open with the server\'s words, and the time is let go', async () => {
    fx.slots = { ...fx.slots, data: { slots: [OTHER], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6] } };
    fx.error = { response: { data: { error: { message: 'That time was just booked.' } } } };
    fx.move.mockImplementation((_v: unknown, opts: { onError: () => void }) => opts.onError());
    const onClose = await render(booking());
    await act(async () => button('12:00 PM')!.click());
    await act(async () => moveButton().click());
    expect(host.textContent).toContain('That time was just booked.');
    expect(onClose).not.toHaveBeenCalled();
    expect(moveButton().disabled).toBe(true);
  });

  it('a failed read of the times is an error with a retry, never "no times"', async () => {
    fx.slots = { data: undefined, isPending: false, isError: true, refetch: () => undefined };
    await render(booking());
    expect(host.textContent).toContain('Couldn’t load the free times.');
    expect(host.textContent).not.toContain('No other free times');
  });

  it('while the move sends, it holds', async () => {
    fx.pending = true;
    fx.slots = { ...fx.slots, data: { slots: [OTHER], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6] } };
    await render(booking());
    await act(async () => button('12:00 PM')!.click());
    expect(moveButton().disabled).toBe(true);
  });
});
