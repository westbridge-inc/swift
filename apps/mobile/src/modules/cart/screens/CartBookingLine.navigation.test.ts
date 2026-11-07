/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [BOOK-POLISH · #2205] A booking line is ONE appointment: the server refuses any
// other number (APPOINTMENT_QUANTITY, 'A booking is for one appointment.'). The
// cart shows a booking line's time where a goods line has its + / − stepper.
// The real cart; native drawing and the transport hooks are stand-ins (the same
// harness as CartSchedule.navigation.test.ts); appointment state is real.
// ---------------------------------------------------------------------------
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
    AddMorph: (p: any) => h('div', { 'data-stepper': String(p.qty) }), Photo: () => null, IconChip: () => null, LockInDisc: () => null,
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

describe('[BOOK-POLISH] a booking line in the cart has no + / −', () => {
  const steppers = () => [...host.querySelectorAll('[data-stepper]')].map((el) => el.getAttribute('data-stepper'));
  /** The cart's lines, before the summary (which names the booking's time on its own). */
  const lines = () => { const text = host.textContent!; const end = text.indexOf('Booking summary'); expect(end).toBeGreaterThan(0); return text.slice(0, end); };
  async function withLine(fulfillment: string, run: () => Promise<void>) {
    const original = fx.cart.items[0]!.fulfillment;
    fx.cart.items[0]!.fulfillment = fulfillment;
    try { await run(); } finally { fx.cart.items[0]!.fulfillment = original; }
  }

  it('a booking line with its time picked: no stepper; the time shows instead (Guyana time)', async () => {
    await withLine('APPOINTMENT', async () => {
      useBookingStore.getState().setAppointment('item', { slotStart: '2026-12-01T16:00:00.000Z', mode: 'AT_BUSINESS' });
      await renderCart();
      expect(steppers()).toEqual([]);
      expect(lines()).toContain('Tue, Dec 1, 12:00 PM');
      // The trash still takes it out.
      expect(host.querySelector('[aria-label="Remove Test item"]')).not.toBeNull();
    });
  });

  it('a home visit says so beside the time', async () => {
    await withLine('APPOINTMENT', async () => {
      useBookingStore.getState().setAppointment('item', { slotStart: '2026-12-01T16:00:00.000Z', mode: 'MOBILE' });
      await renderCart();
      expect(steppers()).toEqual([]);
      expect(lines()).toContain('Tue, Dec 1, 12:00 PM · at your address');
    });
  });

  it('a booking line with no time yet: no stepper, and it says the time is still to pick', async () => {
    await withLine('APPOINTMENT', async () => {
      await renderCart();
      expect(steppers()).toEqual([]);
      expect(lines()).toContain('No time picked yet');
    });
  });

  it('control: a goods line keeps its stepper', async () => {
    await renderCart();
    expect(steppers()).toEqual(['1']);
    expect(host.textContent).not.toContain('No time picked yet');
  });
});
