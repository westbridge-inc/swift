/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Render the real cart and exercise its submit body. Native drawing and the
// transport hooks are stand-ins; pricing choices and appointment state are real.
const fx = vi.hoisted(() => ({
  place: vi.fn(),
  // [BOOK-S6a] The checkout answer a place call hands its onSuccess, and the mutation's success flag.
  answer: null as null | Record<string, unknown>,
  success: false,
  cart: {
    id: 'cart', vendor: { id: 'store', name: 'Test store' },
    items: [{ id: 'line', itemId: 'item', vendorId: 'store', name: 'Test item', quantity: 1, fulfillment: 'DELIVERY', isAvailable: true, lineTotal: 2000, customerPrice: 2000 }],
    deliveryAddress: { addressLine1: 'Test address', city: 'Georgetown' },
    itemCount: 1, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, tipAmount: 0, meetsMinimum: true,
  },
}));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View: Box, ScrollView: Box, Pressable: (p: any) => h('button', { onClick: p.onPress, 'aria-label': p.accessibilityLabel }, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children),
    Platform: { OS: 'ios' }, Alert: { alert: vi.fn() }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ canGoBack: () => false, navigate: vi.fn() }), useFocusEffect: () => undefined }));
vi.mock('../../../services/api', () => ({ customerApi: { validatePromo: vi.fn() } }));
vi.mock('../../../services/notification-priming', () => ({ maybePrimeNotifications: vi.fn() }));
vi.mock('../../../stores/authStore', () => ({ useAuthStore: () => ({ isAuthenticated: true, promptLogin: vi.fn() }) }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: 6.8, longitude: -58.16 }) }));
vi.mock('../../../lib/images', () => ({ itemPhoto: () => undefined }));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn() } }));
vi.mock('../../../lib/payLink', () => ({ openMmgPaymentAction: vi.fn() }));
vi.mock('../../../kit/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../hooks/customer', () => {
  const mutation = () => ({ isPending: false, mutate: vi.fn(), reset: vi.fn() });
  return {
    useCart: () => ({ data: fx.cart, isFetching: false, isPlaceholderData: false, refetch: vi.fn() }),
    useClearCart: mutation, useRemoveCartItem: mutation, useRemoveCartPromo: mutation, useSetCartTip: mutation, useUpdateCartItem: mutation, useAddToCart: mutation, // [TAP-AUDIT] the steppers' add
    usePlaceOrder: () => ({ ...mutation(), mutate: fx.place, isSuccess: fx.success }),
    useCheckoutRecovery: () => ({ recovering: false, placedOrderIds: null }),
    CheckoutAlreadyPlacedError: class extends Error {}, CheckoutInFlightError: class extends Error {}, CheckoutOutcomeUnknownError: class extends Error {}, CHECKING_ORDER_MESSAGE: 'Checking',
  };
});
vi.mock('../../../kit', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  const Button = (p: any) => h('button', { disabled: p.disabled || p.loading, onClick: p.onPress }, p.label);
  return {
    Screen: Box, T: Box, PopupTitle: Box,
    PillButton: Button, Chip: Button,
    PopupCard: (p: any) => p.visible ? h('div', null, p.children) : null,
    LabeledInput: (p: any) => h('div', null, h('input', { placeholder: p.placeholder, value: p.value, readOnly: true }), p.right),
    InfoRow: (p: any) => h('div', null, p.label, p.value),
    Money: (p: any) => h('span', null, p.amount),
    AddMorph: () => null, Photo: () => null, IconChip: () => null, LockInDisc: () => null,
    EmptyState: () => h('div', null, 'Empty'), ErrorState: () => h('div', null, 'Error'), LoadingBlock: () => h('div', null, 'Loading'),
  };
});
vi.mock('../../../kit/controls', async () => ({ BrandSwitch: (p: any) => React.createElement('button', { onClick: p.onChange }, p.label) }));

import { CartScreen } from './CartScreen';
import { useBookingStore } from '../../../stores/bookingStore';
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove(); root = undefined; fx.place.mockReset(); fx.answer = null; fx.success = false; useBookingStore.getState().clear();
});

async function renderCart() {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(CartScreen))));
}

describe('launch cart scheduling', () => {
  it('food/shop checkout offers an immediate order, without a schedule control or schedule in the submitted body', async () => {
    await renderCart();
    expect(host.textContent).toContain('Order summary');
    expect(host.textContent).not.toMatch(/schedule|order later|pick a time/i);
    expect(host.querySelector('input[type=date], input[type=time], input[type=datetime-local]')).toBeNull();
    const place = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Place order')!;
    expect(place).toBeDefined(); expect(place.disabled).toBe(false);
    await act(async () => place.click());
    expect(fx.place).toHaveBeenCalledOnce();
    expect(fx.place.mock.calls[0]![0]).toEqual({ paymentMethod: 'CASH', tipAmount: 0, expectedTotal: 2500, expectedLines: [{ lineId: 'line', unitPrice: 2000 }] });
  });

  it('service appointment slots remain available and travel as appointments, independently of order scheduling', async () => {
    const original = fx.cart.items[0]!.fulfillment;
    try {
      fx.cart.items[0]!.fulfillment = 'APPOINTMENT';
      useBookingStore.getState().setAppointment('item', { slotStart: '2026-12-01T16:00:00.000Z', mode: 'AT_BUSINESS' });
      await renderCart();
      expect(host.textContent).toContain('Booking summary');
      // [BOOK-S6a] The slots answer never said "instant" for this line: it is a request.
      const book = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Request booking')!;
      expect(book.disabled).toBe(false);
      expect(host.textContent).not.toContain('Book now');
      await act(async () => book.click());
      expect(fx.place.mock.calls[0]![0]).toEqual({ paymentMethod: 'CASH', appointments: [{ itemId: 'item', slotStart: '2026-12-01T16:00:00.000Z', mode: 'AT_BUSINESS' }], tipAmount: 0, expectedTotal: 2500, expectedLines: [{ lineId: 'line', unitPrice: 2000 }] });
    } finally { fx.cart.items[0]!.fulfillment = original; }
  });
});

// [BOOK-S6a · REVIEW-F S3-1 on #2193 · owner A3/A4] The button and the success popup follow the server.
describe('instant booking words in the cart', () => {
  const placeAndAnswer = (status: string) => {
    fx.answer = { orders: [{ id: 'o-1', fulfillment: 'APPOINTMENT', status, holdExpiresAt: null }], paymentAction: null, message: 'x' };
    fx.place.mockImplementation((_body: unknown, opts: { onSuccess: (d: unknown) => void }) => { fx.success = true; opts.onSuccess(fx.answer); });
  };
  async function bookWith(instant: boolean, status: string) {
    const original = fx.cart.items[0]!.fulfillment;
    fx.cart.items[0]!.fulfillment = 'APPOINTMENT';
    try {
      useBookingStore.getState().setAppointment('item', { slotStart: '2026-12-01T16:00:00.000Z', ...(instant ? { instant: true } : {}) });
      placeAndAnswer(status);
      await renderCart();
      const label = instant ? 'Book now' : 'Request booking';
      const book = [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
      expect(book).toBeDefined();
      await act(async () => book.click());
      // The flag picked on the item screen is the button's only: it never travels to checkout.
      expect(fx.place.mock.calls[0]![0]).toMatchObject({ appointments: [{ itemId: 'item', slotStart: '2026-12-01T16:00:00.000Z' }] });
      expect(JSON.stringify(fx.place.mock.calls[0]![0])).not.toContain('instant');
    } finally { fx.cart.items[0]!.fulfillment = original; }
  }

  it('an instant line paid cash shows "Book now"; the answer came back ACCEPTED, so the popup says "Booking confirmed"', async () => {
    await bookWith(true, 'ACCEPTED');
    expect(host.textContent).toContain('Booking confirmed');
    expect(host.textContent).not.toContain('Booking requested');
    // The popup's own words (the cart behind it is the test's fixed fixture, not the emptied cart).
    const popup = host.textContent!.slice(host.textContent!.indexOf('Booking confirmed'));
    expect(popup).toContain('Your time is confirmed — pay cash directly to the business when the service is done.');
    expect(popup).not.toContain('when the business accepts');
  });

  it('an instant line whose answer came back PENDING (the server judged it a request) says "Booking requested"', async () => {
    await bookWith(true, 'PENDING');
    expect(host.textContent).toContain('Booking requested');
    expect(host.textContent).not.toContain('Booking confirmed');
  });

  it('a request line says "Request booking", and its PENDING answer "Booking requested"', async () => {
    await bookWith(false, 'PENDING');
    expect(host.textContent).toContain('Booking requested');
  });
});
