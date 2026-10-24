/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [row 5 · ANDROID-QA 5 Oct, S3] "First cancel tap dropped while slow."
//
// The REAL order screen over the REAL order hooks and a real query client;
// the transport, the socket, native drawing and the toast are stand-ins.
// Two things dropped the first cancel tap on a slow line:
// 1. One timed-out background read (the 15 s poll, a reconnect) swapped the
//    whole order screen, Cancel button included, for an error screen until
//    the next read landed.
// 2. Cancel first re-reads the order (is it still cancellable?). That read was
//    `order.refetch()`, the screen's SHARED query, and the screen's own
//    background refreshes (a socket reconnect, a status event, the hold timer)
//    call `order.refetch()` too. That cancels the tap's read in flight and
//    makes the tap wait for the newer read instead. On a slow line that read
//    can time out, so the tap said "Couldn't confirm cancellation" although
//    its own read answered.
// ---------------------------------------------------------------------------

type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const deferred = (): Deferred => {
  let resolve!: (v: unknown) => void; let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const fx = vi.hoisted(() => ({
  getOrder: vi.fn(),
  cancelOrder: vi.fn(),
  handlers: new Map<string, (payload?: unknown) => void>(),
  toastError: vi.fn(),
  toastShow: vi.fn(),
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

const ORDER = {
  id: 'order-1', orderNumber: 'SW-1001', orderType: 'FOOD_DELIVERY', status: 'PENDING', fulfillment: 'DELIVERY',
  vendor: { id: 'store-1', name: 'Test store' }, items: [], placedAt: '2026-10-16T12:00:00.000Z',
  paymentMethod: 'CASH', paymentStatus: 'PENDING', canCancel: true, totalAmount: 2500, subtotal: 2500,
  cancellationMessage: 'Cancelling now is free.',
};
const answer = (data: unknown) => ({ data: { data } });
const slowLineTimeout = () => Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };
const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
async function tap(label: string) {
  const b = button(label);
  expect(b, `"${label}" is on screen and enabled`).toBeTruthy();
  expect(b!.disabled).toBe(false);
  await act(async () => { b!.click(); });
}
/** The screen's own background refresh, as a reconnect on a slow line fires it. */
async function socketReconnects() {
  const onConnect = fx.handlers.get('connect');
  expect(onConnect, 'the screen listens for reconnects').toBeTruthy();
  await act(async () => { onConnect!(); });
}

async function renderAfterATimedOutPoll() {
  fx.getOrder.mockResolvedValueOnce(answer(ORDER));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(DeliveryScreen))));
  await flush();
  expect(host.textContent).toContain('SW-1001');
  // An earlier background read timed out on the slow line: the screen keeps
  // the order it has, and the query remembers the failure.
  fx.getOrder.mockRejectedValueOnce(slowLineTimeout());
  await socketReconnects();
  await flush();
  expect(client.getQueryState(['customer', 'order', 'order-1'])?.status).toBe('error');
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.handlers.clear();
  fx.getOrder.mockReset(); fx.cancelOrder.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); client.clear();
});

describe('the first cancel tap works on a slow line', () => {
  it('Cancel: a reconnect refresh during the tap’s own read does not drop the tap', async () => {
    await renderAfterATimedOutPoll();
    const tapRead = deferred();
    const backgroundRead = deferred();
    fx.getOrder.mockImplementationOnce(() => tapRead.promise).mockImplementationOnce(() => backgroundRead.promise);
    await tap('Cancel order');
    await socketReconnects(); // the slow line drops and comes back mid-read
    tapRead.resolve(answer(ORDER)); // the tap's own read answers
    backgroundRead.reject(slowLineTimeout()); // the reconnect's read times out
    await flush();
    expect(fx.toastError).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Cancel this order?');
  });

  it('Yes, cancel it: a reconnect refresh during the recheck does not drop the confirmation', async () => {
    fx.getOrder.mockResolvedValue(answer(ORDER));
    await renderAfterATimedOutPoll();
    fx.getOrder.mockResolvedValueOnce(answer(ORDER));
    await tap('Cancel order');
    await flush();
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    // The background read fails again while the recheck is in flight.
    const recheck = deferred();
    fx.getOrder.mockImplementationOnce(() => recheck.promise).mockImplementationOnce(() => Promise.reject(slowLineTimeout()));
    fx.cancelOrder.mockResolvedValueOnce({ message: 'Order cancelled.' });
    await tap('Yes, cancel it');
    await socketReconnects();
    await flush();
    recheck.resolve(answer(ORDER));
    await flush();
    expect(fx.toastError).not.toHaveBeenCalled();
    expect(fx.cancelOrder).toHaveBeenCalledOnce();
    expect(fx.cancelOrder).toHaveBeenCalledWith('order-1');
  });

  it('control: a read that really fails still says so, and nothing is cancelled', async () => {
    await renderAfterATimedOutPoll();
    fx.getOrder.mockRejectedValueOnce(slowLineTimeout());
    await tap('Cancel order');
    await flush();
    expect(fx.toastError).toHaveBeenCalledWith('Couldn’t confirm cancellation', 'Check your connection and try again. Your order is unchanged.');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(fx.cancelOrder).not.toHaveBeenCalled();
  });

  it('control: an order that is no longer cancellable is refused on the fresh answer, not the cached one', async () => {
    await renderAfterATimedOutPoll();
    fx.getOrder.mockResolvedValueOnce(answer({ ...ORDER, status: 'PREPARING', canCancel: false, cancelUnavailable: { message: 'The store has started on it.' } }));
    await tap('Cancel order');
    await flush();
    expect(fx.toastShow).toHaveBeenCalledWith('This order can no longer be cancelled', 'The store has started on it.');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});
