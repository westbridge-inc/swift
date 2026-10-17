/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [row 5 · ANDROID-QA 5 Oct, S2] "Lost-response shows empty cart."
//
// The REAL cart screen, drawn by a real React renderer. The order went through
// but its reply was lost; the phone's receipt probe (or a replayed key) then
// says "placed". The server had already emptied the cart inside the order's own
// transaction, so the refetched cart is empty — and the screen said "Your cart
// is empty / Find food", hiding the only line that said the order exists. A
// customer who then re-added their items found Place order dead ("already
// placed") until the app restarted.
//
// The checkout hooks are stand-ins that hand over each outcome; the screen's
// own decisions are what is asserted.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => {
  class CheckoutAlreadyPlacedError extends Error {
    constructor(readonly orderIds: string[]) { super('This order was already placed.'); }
  }
  class CheckoutInFlightError extends Error {}
  class CheckoutOutcomeUnknownError extends Error {}
  return {
    CheckoutAlreadyPlacedError, CheckoutInFlightError, CheckoutOutcomeUnknownError,
    navigate: vi.fn(),
    place: vi.fn(),
    reset: vi.fn(),
    cart: null as any,
    error: null as unknown,
    checkingOutcome: false,
    recovery: { recovering: false, placedOrderIds: null as string[] | null },
  };
});
const CART = {
  id: 'cart', vendor: { id: 'store', name: 'Test store' },
  items: [{ id: 'line', itemId: 'item', vendorId: 'store', name: 'Test item', quantity: 1, fulfillment: 'DELIVERY', isAvailable: true, lineTotal: 2000, customerPrice: 2000 }],
  deliveryAddress: { addressLine1: 'Test address', city: 'Georgetown' },
  itemCount: 1, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, tipAmount: 0, meetsMinimum: true,
};

vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View: Box, ScrollView: Box, Pressable: (p: any) => h('button', { onClick: p.onPress, 'aria-label': p.accessibilityLabel }, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children),
    Platform: { OS: 'android' }, Alert: { alert: vi.fn() }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ canGoBack: () => false, navigate: fx.navigate }), useFocusEffect: () => undefined }));
vi.mock('../../../services/api', () => ({ customerApi: { validatePromo: vi.fn() } }));
vi.mock('../../../services/notification-priming', () => ({ maybePrimeNotifications: vi.fn() }));
vi.mock('../../../stores/authStore', () => ({ useAuthStore: () => ({ isAuthenticated: true, promptLogin: vi.fn() }) }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: 6.8, longitude: -58.16 }) }));
vi.mock('../../../lib/images', () => ({ itemPhoto: () => undefined }));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn() } }));
vi.mock('../../../lib/payLink', () => ({ openMmgPaymentAction: vi.fn() }));
vi.mock('../../../kit/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), show: vi.fn() } }));
vi.mock('../../../hooks/customer', () => {
  const mutation = () => ({ isPending: false, mutate: vi.fn(), reset: vi.fn() });
  return {
    useCart: () => ({ data: fx.cart, isLoading: false, isFetching: false, isPlaceholderData: false, refetch: vi.fn() }),
    useClearCart: mutation, useRemoveCartItem: mutation, useRemoveCartPromo: mutation, useSetCartTip: mutation, useUpdateCartItem: mutation,
    usePlaceOrder: () => ({
      ...mutation(), mutate: fx.place, reset: fx.reset,
      error: fx.error, isError: fx.error != null, isSuccess: false, checkingOutcome: fx.checkingOutcome,
    }),
    useCheckoutRecovery: () => fx.recovery,
    CheckoutAlreadyPlacedError: fx.CheckoutAlreadyPlacedError, CheckoutInFlightError: fx.CheckoutInFlightError,
    CheckoutOutcomeUnknownError: fx.CheckoutOutcomeUnknownError, CHECKING_ORDER_MESSAGE: "We're checking whether your order went through.",
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
    EmptyState: (p: any) => h('section', { 'data-empty': p.title }, h('h2', null, p.title), p.body ? h('p', null, p.body) : null,
      p.actionLabel ? h('button', { onClick: p.onAction }, p.actionLabel) : null),
    ErrorState: () => h('div', null, 'Error'), LoadingBlock: () => h('div', null, 'Loading'),
  };
});
vi.mock('../../../kit/controls', async () => ({ BrandSwitch: (p: any) => React.createElement('button', { onClick: p.onChange }, p.label) }));

import { CartScreen } from './CartScreen';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  fx.cart = null; fx.error = null; fx.checkingOutcome = false;
  fx.recovery = { recovering: false, placedOrderIds: null };
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined;
});

async function render() {
  await act(async () => root!.render(React.createElement(QueryClientProvider, { client }, React.createElement(CartScreen))));
}
const text = () => host.textContent ?? '';
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
async function tap(label: string) {
  const b = button(label);
  expect(b, `"${label}" is on screen`).toBeDefined();
  await act(async () => b!.click());
}

describe('a lost reply whose order went through', () => {
  it('the emptied cart says the order went through, and Track your order opens it', async () => {
    fx.error = new fx.CheckoutAlreadyPlacedError(['order-9']);
    await render();
    expect(text()).toContain('Your order went through');
    expect(text()).not.toContain('Your cart is empty');
    await tap('Track your order');
    expect(fx.navigate).toHaveBeenCalledWith('Delivery', { orderId: 'order-9' });
    // Opened = acknowledged: back on the cart with new things, nothing says
    // "already placed" and nothing calls the outcome a failure.
    fx.cart = CART;
    await render();
    expect(text()).not.toContain('already placed');
    expect(text()).not.toContain('Could not place the order');
    expect(button('Place order')!.disabled).toBe(false);
  });

  it('after a restart, a recovered order of several stores opens the orders list', async () => {
    fx.recovery = { recovering: false, placedOrderIds: ['order-1', 'order-2'] };
    await render();
    expect(text()).toContain('Your order went through');
    await tap('See your orders');
    expect(fx.navigate).toHaveBeenCalledWith('OrdersHistory');
  });

  it('while the phone is still asking, an emptied cart says so instead of "empty"', async () => {
    fx.checkingOutcome = true;
    await render();
    expect(text()).toContain("We're checking whether your order went through.");
    expect(text()).not.toContain('Your cart is empty');
    await tap('See your orders');
    expect(fx.navigate).toHaveBeenCalledWith('OrdersHistory');
  });

  it('new things in the cart after it was emptied by that order can be ordered (no dead button)', async () => {
    fx.error = new fx.CheckoutAlreadyPlacedError(['order-9']);
    await render();
    expect(text()).toContain('Your order went through');
    fx.cart = CART; // the customer adds something new
    await render();
    await render();
    expect(text()).not.toContain('already placed');
    expect(text(), 'an acknowledged outcome is not a failure').not.toContain('Could not place the order');
    const place = button('Place order');
    expect(place, 'Place order is on screen').toBeDefined();
    expect(place!.disabled).toBe(false);
  });

  it('control: no outcome, no cart — the ordinary empty cart', async () => {
    await render();
    expect(text()).toContain('Your cart is empty');
    expect(text()).not.toContain('went through');
  });

  it('control: a placed outcome over the cart it came from (never seen emptied) still refuses a second order', async () => {
    fx.error = new fx.CheckoutAlreadyPlacedError(['order-9']);
    fx.cart = CART;
    await render();
    await render();
    expect(text()).toContain('This order was already placed — it is in your orders.');
    expect(button('Place order')!.disabled).toBe(true);
  });
});
