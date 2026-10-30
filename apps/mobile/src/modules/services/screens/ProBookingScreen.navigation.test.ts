/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';

// [BOOK-P3] Booking a pro from their list: the server's services, the server's free times, a booking that
// carries the price the customer was shown, and the server's words (and a reload) when it refuses. The
// transport hooks are stand-ins; the screen is real.
const fx = vi.hoisted(() => ({
  book: vi.fn(),
  offerings: { data: undefined as unknown, isPending: false, isError: false, error: null as unknown, refetch: vi.fn() } as Record<string, unknown>,
  slots: { data: { slots: [] as string[] }, isPending: false, isError: false, refetch: vi.fn() } as Record<string, unknown>,
  asked: [] as Array<[string, string, string]>,
  navigate: vi.fn(),
}));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  const Press = (p: any) => h('div', { role: 'radio', 'aria-label': p.accessibilityLabel, onClick: p.onPress }, p.children);
  return { View: Box, ScrollView: Box, Pressable: Press };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('../../../kit', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  const Button = (p: any) => h('button', { disabled: p.disabled || p.loading, onClick: p.onPress }, p.label);
  const Text = (p: any) => h('span', null, p.label ?? p.title ?? p.message ?? p.children);
  const Input = (p: any) => h('input', { 'aria-label': p.label, value: p.value, onChange: (e: any) => p.onChangeText(e.target.value) });
  const Popup = (p: any) => (p.visible ? h('section', null, p.children) : null);
  const Error = (p: any) => h('div', null, p.message, h('button', { onClick: p.onRetry }, 'Try again'));
  const Empty = (p: any) => h('div', null, p.title, ' ', p.body);
  return {
    Card: Box, Chip: Button, DecorativeIcon: Box, EmptyState: Empty, ErrorState: Error, Header: Text, LabeledInput: Input,
    LoadingBlock: () => h('span', null, 'Loading'), PillButton: Button, PopupCard: Popup, PopupTitle: Box, Screen: Box,
    SectionHeader: Text, T: Box, TonePill: Text,
  };
});
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));
vi.mock('../../../hooks', () => ({
  useProOfferings: () => fx.offerings,
  useProSlots: (providerId: string, offeringId: string, date: string) => { fx.asked.push([providerId, offeringId, date]); return fx.slots; },
  useBookPro: () => ({ mutate: fx.book, isPending: false }),
}));

import { ProBookingScreen } from './ProBookingScreen';

const T10 = '2026-12-01T14:00:00.000Z'; // 10:00 AM in Guyana
const T12 = '2026-12-01T16:00:00.000Z'; // 12:00 PM in Guyana
const ANSWER = {
  providerId: 'pro-1', tradeLabel: 'Tutor', paymentMethod: 'CASH', minNoticeMinutes: 120, horizonDays: 366, bookableWeekdays: [0, 1, 2, 3, 4, 5, 6],
  offerings: [{ id: 'o-1', name: 'Maths lesson', durationMinutes: 60, price: 3000.5 }, { id: 'o-2', name: 'Exam prep', durationMinutes: 90, price: 4500 }],
};

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove(); root = undefined; fx.book.mockReset(); fx.navigate.mockReset(); fx.asked = [];
  fx.offerings = { data: undefined, isPending: false, isError: false, error: null, refetch: vi.fn() };
  fx.slots = { data: { slots: [] }, isPending: false, isError: false, refetch: vi.fn() };
});
async function render() {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(ProBookingScreen, { navigation: { navigate: fx.navigate }, route: { params: { providerId: 'pro-1' } } })));
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const bookButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Book '));
const pickService = async (name: string) => act(async () => (host.querySelector(`[aria-label^="${name},"]`) as HTMLElement).click());

describe('[BOOK-P3] booking a pro from their list', () => {
  it('lists the services with their prices; the server\'s free times for the chosen one; books at the price shown', async () => {
    fx.offerings = { ...fx.offerings, data: ANSWER };
    fx.slots = { ...fx.slots, data: { slots: [T10, T12] } };
    await render();
    expect(host.textContent).toContain('Maths lesson');
    expect(host.textContent).toContain('Exam prep');
    expect(fx.asked.every(([, offeringId]) => offeringId === '')).toBe(true);
    await pickService('Maths lesson');
    expect(fx.asked.at(-1)!.slice(0, 2)).toEqual(['pro-1', 'o-1']);
    expect(button('Pick a time')!.disabled).toBe(true);
    await act(async () => button('12:00 PM')!.click());
    await act(async () => bookButton()!.click());
    expect(fx.book).toHaveBeenCalledOnce();
    expect(fx.book.mock.calls[0]![0]).toEqual({ providerId: 'pro-1', offeringId: 'o-1', scheduledFor: T12, expectedPrice: 3000.5 });
  });

  it('booked: "Booking confirmed", cash at the appointment, and My jobs one tap away', async () => {
    fx.offerings = { ...fx.offerings, data: { ...ANSWER, offerings: [ANSWER.offerings[0]] } };
    fx.slots = { ...fx.slots, data: { slots: [T10] } };
    fx.book.mockImplementation((_v: unknown, opts: { onSuccess: () => void }) => opts.onSuccess());
    await render();
    // One service: it is picked for the customer.
    await act(async () => button('10:00 AM')!.click());
    await act(async () => bookButton()!.click());
    expect(host.textContent).toContain('Booking confirmed');
    expect(host.textContent).toContain('Pay cash at the appointment.');
    await act(async () => button('View my jobs')!.click());
    expect(fx.navigate).toHaveBeenCalledWith('ServiceJobs');
  });

  it('a taken time: the server\'s words, the time let go, the times reloaded; a changed price reloads the services', async () => {
    fx.offerings = { ...fx.offerings, data: ANSWER };
    fx.slots = { ...fx.slots, data: { slots: [T10] } };
    const refuse = (code: string, message: string) => fx.book.mockImplementationOnce((_v: unknown, opts: { onError: (e: unknown) => void }) => opts.onError({ response: { data: { error: { code, message } } } }));
    await render();
    await pickService('Maths lesson');
    refuse('SLOT_TAKEN', 'That time was just booked with this provider — pick another time');
    await act(async () => button('10:00 AM')!.click());
    await act(async () => bookButton()!.click());
    expect(host.textContent).toContain('That time was just booked with this provider — pick another time');
    expect(button('Pick a time')!.disabled).toBe(true);
    expect(fx.slots['refetch']).toHaveBeenCalled();
    refuse('PRICE_CHANGED', 'The price of this service changed to GYD 3500. Check it and book again.');
    await act(async () => button('10:00 AM')!.click());
    await act(async () => bookButton()!.click());
    expect(host.textContent).toContain('The price of this service changed to GYD 3500.');
    expect(fx.offerings['refetch']).toHaveBeenCalled();
  });

  it('a pro who is not taking bookings from a list: the server\'s words and a retry, never an empty list', async () => {
    fx.offerings = { ...fx.offerings, isError: true, error: { response: { data: { error: { code: 'PROVIDER_AGREEMENT_PENDING', message: 'This provider isn’t taking bookings from their list of services yet. Ask them for a quote instead.' } } } } };
    await render();
    expect(host.textContent).toContain('isn’t taking bookings from their list of services yet');
    expect(button('Try again')).toBeDefined();
    expect(fx.book).not.toHaveBeenCalled();
  });
});
