/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';

// [BOOK-S5a · owner C1] "How many bookings at once" for a Services business.
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  return { View: Box };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('../kit', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  const Button = (p: any) => h('button', { disabled: p.disabled || p.loading, onClick: p.onPress }, p.label);
  return { Card: Box, T: Box, PillButton: Button, Chip: Button };
});

import { BOOKING_CAPACITY_MAX, BookingCapacityCard, storedBookingCapacity } from './BookingCapacityCard';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; });
async function render(props: { value: number; error?: string | null; saving?: boolean }, onSave = vi.fn()) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(BookingCapacityCard, { ...props, onSave })));
  return onSave;
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);

describe('[BOOK-S5a] how many bookings at once', () => {
  it('the stored number, or null from an older server', () => {
    expect(storedBookingCapacity({ bookingCapacity: 3 })).toBe(3);
    for (const v of [undefined, null, {}, { bookingCapacity: 0 }, { bookingCapacity: 1.5 }, { bookingCapacity: '2' }]) expect(storedBookingCapacity(v)).toBeNull();
  });

  it('one at a time says so; More then Save sends the new number', async () => {
    const onSave = await render({ value: 1 });
    expect(host.textContent).toContain('One booking at a time across all your services.');
    expect(button('Save')).toBeUndefined();
    await act(async () => button('More')!.click());
    await act(async () => button('More')!.click());
    expect(host.textContent).toContain('Up to 3 bookings at the same time, across all your services.');
    await act(async () => button('Save')!.click());
    expect(onSave).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('never below 1 nor above the server\'s most', async () => {
    await render({ value: 1 });
    await act(async () => button('Fewer')!.click());
    expect(button('Save')).toBeUndefined();
    await act(async () => { for (let i = 0; i < 30; i += 1) button('More')!.click(); });
    expect(host.textContent).toContain(`Up to ${BOOKING_CAPACITY_MAX} bookings`);
  });

  it('the server\'s refusal in its words; Save holds while saving', async () => {
    await render({ value: 3, error: 'You already have 3 appointments at the same time (Mon 10:00 AM).', saving: true });
    expect(host.textContent).toContain('You already have 3 appointments at the same time (Mon 10:00 AM).');
    await act(async () => button('Fewer')!.click());
    expect(button('Save')!.disabled).toBe(true);
  });
});
