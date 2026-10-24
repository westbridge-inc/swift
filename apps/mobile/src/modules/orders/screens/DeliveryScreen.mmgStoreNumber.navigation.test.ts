/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] The REAL order screen over the REAL
// order hooks: when the server sends `mmgPayment` (only to this order's
// customer, only after the store accepted, only until "Paid by MMG"), the
// screen says "Pay $X by MMG to <store>'s MMG number <number>" and opens no
// payment page. A malformed answer shows nothing.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  getOrder: vi.fn(),
  cancelOrder: vi.fn(),
  handlers: new Map<string, (payload?: unknown) => void>(),
  toastError: vi.fn(),
  toastShow: vi.fn(),
  copied: [] as string[],
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const View = (p: any) => h('div', a11y(p), p.children);
  const Pressable = (p: any) => h('div', { ...a11y(p), role: p.accessibilityRole ?? 'button', onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View, Pressable, Text: View, ScrollView: View,
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
    Platform: { OS: 'android' },
    Linking: { openURL: vi.fn(async () => true) },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Share: { share: vi.fn() },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  return { __esModule: true, default: (p: any) => R.createElement('div', { 'data-map': '' }, p.children), Marker: () => null };
});
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ navigate: vi.fn(), goBack: vi.fn(), canGoBack: () => true }),
  useRoute: () => ({ params: { orderId: 'order-1' } }),
}));
vi.mock('../../../components/MapCredits', () => ({ MapCredits: () => null }));
vi.mock('../../safety/SosCeremony', () => ({ SosCeremony: () => null }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: null, longitude: null, status: 'denied' }) }));
vi.mock('../../../lib/deviceLocation', () => ({ grantedLocationFix: () => null }));
// The REAL hooks/customer runs; these are its own dependencies.
vi.mock('../../../services/api', () => ({
  API_URL: 'https://api.test', WEB_URL: 'https://web.test',
  customerApi: { getOrder: fx.getOrder, cancelOrder: fx.cancelOrder },
  courierApi: {}, marketApi: {}, discoveryApi: {}, moderationApi: {},
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../../../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn(), checkoutFailureOutcome: vi.fn(), settleUnresolvedIntent: vi.fn() }));
vi.mock('../../../lib/marketDepthMemory', () => ({ rememberedMarketDepth: vi.fn(), rememberMarketDepth: vi.fn() }));
vi.mock('../../../stores/authStore', () => {
  const state = { isAuthenticated: true, sessionGeneration: 1, user: { id: 'customer-1' } };
  return {
    useAuthStore: Object.assign((select?: (s: typeof state) => unknown) => (select ? select(state) : state), { getState: () => state }),
    getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: vi.fn(), AuthSessionBoundaryError: class extends Error {},
  };
});
vi.mock('../../../services/socket', () => ({
  connectSocket: vi.fn(), subscribeToOrder: vi.fn(),
  getSocket: () => ({
    connected: true,
    on: (event: string, fn: (payload?: unknown) => void) => { fx.handlers.set(event, fn); },
    off: (event: string) => { fx.handlers.delete(event); },
    emit: vi.fn(),
  }),
}));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn(), failure: vi.fn(), commit: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../lib/payLink', () => ({ openMmgPaymentAction: vi.fn(), safeMmgPaymentActionUrl: () => false }));
vi.mock('../../../lib/clipboard', () => ({ copyText: (t: string) => { fx.copied.push(t); return true; } }));
vi.mock('../../../kit/toast', () => ({ toast: { show: fx.toastShow, error: fx.toastError, success: vi.fn() } }));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));
vi.mock('../../../kit/vertical-tint', () => ({ VERTICAL_TINT: {} }));
vi.mock('../MmgPaymentClaimCard', () => ({ MmgPaymentClaimCard: () => null }));
vi.mock('../CustodyRecoveryNotice', () => ({ CustodyRecoveryNotice: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const Box = (p: any) => h('div', a11y(p), p.children);
  const T = (p: any) => h('span', a11y(p), p.children);
  return {
    T, Eyebrow: T, PopupTitle: T, DecorativeIcon: Box, IconChip: () => null, CircleChip: Box,
    InfoRow: (p: any) => h('div', null, p.label, p.value),
    Timeline: () => null, HoldRing: () => null, LoadingBlock: () => h('div', null, 'Loading'), ErrorState: () => h('div', null, 'Error'),
    // The kit header (its Back chip) on the loading and failure branches [UI-SWEEP U32].
    Header: () => h('div', { 'aria-label': 'Back' }),
    PillButton: (p: any) => h('button', { type: 'button', 'aria-label': p.label, disabled: !!(p.disabled || p.loading), onClick: p.disabled || p.loading ? undefined : p.onPress }, p.label),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    holdRingCaption: () => '', holdRingWindow: () => null,
  };
});

import { DeliveryScreen } from './DeliveryScreen';

const PAYMENT = {
  payTo: 'STORE_NUMBER', provider: 'MMG', fundsFlow: 'DIRECT_TO_VENDOR', recipientName: 'Number Diner',
  number: '+5926001234', numberDisplay: '+592 600 1234', amount: 2800, currencyCode: 'GYD',
  instruction: "Pay $2,800 by MMG to Number Diner's MMG number +592 600 1234.",
};
const ORDER = {
  id: 'order-1', orderNumber: 'SW-2001', orderType: 'FOOD_DELIVERY', status: 'ACCEPTED', fulfillment: 'DELIVERY',
  vendor: { id: 'store-1', name: 'Number Diner' }, items: [], placedAt: '2026-10-17T12:00:00.000Z',
  paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', canCancel: true, totalAmount: 2800, subtotal: 2500,
  paymentAction: null,
};
const answer = (data: unknown) => ({ data: { data } });

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };
async function show(order: Record<string, unknown>) {
  fx.getOrder.mockResolvedValue(answer(order));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(DeliveryScreen))));
  await flush();
  expect(host.textContent).toContain('SW-2001');
}
const card = () => host.querySelector('[data-testid="mmg-store-number"]');

beforeEach(() => {
  vi.clearAllMocks();
  fx.handlers.clear(); fx.copied.length = 0;
  fx.getOrder.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); client.clear();
});

describe('[PAYMENT-SIMPLIFY] the accepted MMG order shows the store number', () => {
  it('shows the server sentence, who confirms it, and copies the number', async () => {
    await show({ ...ORDER, mmgPayment: PAYMENT });
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain("Pay $2,800 by MMG to Number Diner's MMG number +592 600 1234.");
    expect(card()!.textContent).toContain('Number Diner marks your order paid when the money arrives. Swift never holds this money.');
    const copy = host.querySelector('button[aria-label="Copy MMG number"]') as HTMLButtonElement;
    await act(async () => { copy.click(); });
    expect(fx.copied).toEqual(['+5926001234']);
    expect(fx.toastShow).toHaveBeenCalledWith('MMG number copied');
  });

  it('no mmgPayment (not accepted yet, or already paid): no number on screen', async () => {
    await show({ ...ORDER, status: 'PENDING', mmgPayment: null });
    expect(card()).toBeNull();
    expect(host.textContent).not.toContain('600 1234');
  });

  it('a malformed answer (a landline) shows nothing rather than a wrong number', async () => {
    await show({ ...ORDER, mmgPayment: { ...PAYMENT, number: '+5922251234', numberDisplay: '+592 225 1234', instruction: 'Pay $2,800 by MMG to +592 225 1234.' } });
    expect(card()).toBeNull();
  });

  it('a cancelled order never shows it', async () => {
    await show({ ...ORDER, status: 'CANCELLED', canCancel: false, mmgPayment: PAYMENT });
    expect(card()).toBeNull();
  });

  // [owner 18 Oct 2026] Not marked "Paid by MMG" within 30 minutes of acceptance = cancelled automatically.
  it("says when the order cancels if it isn't marked paid (the server's sentence)", async () => {
    const deadline = "If Number Diner hasn't marked it paid by 3:45 PM, the order is cancelled automatically.";
    await show({ ...ORDER, mmgPayment: { ...PAYMENT, payBy: '2026-10-17T19:45:00.000Z', deadline } });
    expect(card()!.textContent).toContain(deadline);
  });

  it('an order that cancelled because it was not marked paid in time says why', async () => {
    const notice = "Number Diner didn't mark your MMG payment as received within 30 minutes of accepting, so this order was cancelled automatically. If you already sent the MMG payment, Number Diner refunds you directly.";
    await show({ ...ORDER, status: 'CANCELLED', canCancel: false, mmgPayment: null, cancellationNotice: notice });
    expect(host.textContent).toContain(notice);
  });
});
