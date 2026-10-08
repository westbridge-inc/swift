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
    useClearCart: mutation, useRemoveCartItem: mutation, useRemoveCartPromo: mutation, useSetCartTip: mutation, useUpdateCartItem: mutation,
    usePlaceOrder: () => ({ ...mutation(), mutate: fx.place }),
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
  host?.remove(); root = undefined; fx.place.mockClear(); useBookingStore.getState().clear();
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
      const book = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Book now')!;
      expect(book.disabled).toBe(false);
      await act(async () => book.click());
      expect(fx.place.mock.calls[0]![0]).toEqual({ paymentMethod: 'CASH', appointments: [{ itemId: 'item', slotStart: '2026-12-01T16:00:00.000Z', mode: 'AT_BUSINESS' }], tipAmount: 0, expectedTotal: 2500, expectedLines: [{ lineId: 'line', unitPrice: 2000 }] });
    } finally { fx.cart.items[0]!.fulfillment = original; }
  });
});
