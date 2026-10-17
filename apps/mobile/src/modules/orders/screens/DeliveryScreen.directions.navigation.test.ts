/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [row 363] The store-pickup "Directions" button on the REAL order screen,
// drawn by a real React renderer. Before: it opened maps.apple.com on every
// phone, so an Android customer got a web page instead of Google Maps. Now the
// phone's own maps: Apple Maps on iOS (same link as before), Google Maps on
// Android, and the Google web map when Apple Maps will not open.
// Native drawing, the order hook and the socket are stand-ins; the real
// openExternal runs over a stand-in Linking.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  order: null as any,
  platform: { OS: 'ios' as string },
  openURL: vi.fn(async (_url: string) => true),
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
    Platform: fx.platform,
    Linking: { openURL: (url: string) => fx.openURL(url) },
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
vi.mock('../../../hooks/customer', () => ({
  useOrder: () => ({ data: fx.order, isLoading: false, isError: false, refetch: vi.fn(async () => ({ data: fx.order, isError: false })) }),
  useDecideSubstitution: () => ({ mutate: vi.fn(), isPending: false }),
  useClaimMmgPayment: () => ({ mutate: vi.fn(), isPending: false }),
  customerKeys: { homeAll: ['customer', 'home'], order: (id: string) => ['customer', 'order', id] },
}));
vi.mock('../../../services/api', () => ({ customerApi: {}, courierApi: {}, WEB_URL: 'https://web.test' }));
vi.mock('../../../services/socket', () => ({
  connectSocket: vi.fn(), subscribeToOrder: vi.fn(),
  getSocket: () => ({ connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() }),
}));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn(), failure: vi.fn(), commit: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../lib/payLink', () => ({ openMmgPaymentAction: vi.fn(), safeMmgPaymentActionUrl: () => false }));
vi.mock('../../../kit/toast', () => ({ toast: { show: fx.toastShow, error: vi.fn(), success: vi.fn() } }));
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
    PillButton: (p: any) => h('button', { type: 'button', 'aria-label': p.label, disabled: !!(p.disabled || p.loading), onClick: p.disabled || p.loading ? undefined : p.onPress }, p.label),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    holdRingCaption: () => '', holdRingWindow: () => null,
  };
});

import { DeliveryScreen } from './DeliveryScreen';

const readyForPickup = (over: Record<string, unknown> = {}) => ({
  id: 'order-1', orderNumber: 'SW-1001', orderType: 'FOOD', status: 'READY_FOR_PICKUP', fulfillment: 'PICKUP',
  pickupCode: '4821', pickupAddress: 'Lot 1 Test Street, Georgetown', pickupLat: 6.81, pickupLng: -58.16,
  vendor: { id: 'store-1', name: 'Test store' }, items: [], placedAt: '2026-10-16T12:00:00.000Z',
  paymentMethod: 'CASH', paymentStatus: 'PENDING', canCancel: false, totalAmount: 2500, subtotal: 2500,
  ...over,
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function render(order: unknown) {
  fx.order = order;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(DeliveryScreen))));
}
async function tapDirections() {
  const el = host.querySelector('[aria-label="Directions to Test store"]') as HTMLElement | null;
  expect(el, 'the Directions control is on screen').toBeTruthy();
  await act(async () => { el!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.platform.OS = 'ios';
  fx.openURL.mockImplementation(async () => true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('store pickup Directions open the phone’s own maps', () => {
  it('Android: Google Maps, never the Apple Maps web page', async () => {
    fx.platform.OS = 'android';
    await render(readyForPickup());
    expect(host.textContent).toContain('It’s ready.');
    await tapDirections();
    expect(fx.openURL).toHaveBeenCalledOnce();
    expect(fx.openURL).toHaveBeenCalledWith('https://www.google.com/maps/dir/?api=1&destination=6.81,-58.16');
    expect(fx.openURL.mock.calls.flat().join(' ')).not.toContain('apple.com');
  });

  it('control: iOS keeps Apple Maps at the order’s own pickup coordinates', async () => {
    await render(readyForPickup());
    await tapDirections();
    expect(fx.openURL).toHaveBeenCalledOnce();
    expect(fx.openURL).toHaveBeenCalledWith('https://maps.apple.com/?daddr=6.81,-58.16');
  });

  it('iOS: when Apple Maps will not open, the Google web map opens instead', async () => {
    fx.openURL.mockImplementationOnce(async () => { throw new Error('no handler'); });
    await render(readyForPickup());
    await tapDirections();
    expect(fx.openURL).toHaveBeenCalledTimes(2);
    expect(fx.openURL.mock.calls[1]![0]).toBe('https://www.google.com/maps/dir/?api=1&destination=6.81,-58.16');
    expect(fx.toastShow).not.toHaveBeenCalled();
  });

  it('Android with no coordinates: Google Maps searches the store address', async () => {
    fx.platform.OS = 'android';
    await render(readyForPickup({ pickupLat: null, pickupLng: null }));
    await tapDirections();
    expect(fx.openURL).toHaveBeenCalledWith(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent('Lot 1 Test Street, Georgetown')}`);
  });

  it('nothing opens: the customer is told, not left with a dead tap', async () => {
    fx.platform.OS = 'android';
    fx.openURL.mockImplementation(async () => { throw new Error('no handler'); });
    await render(readyForPickup());
    await tapDirections();
    expect(fx.toastShow).toHaveBeenCalledWith("Couldn't open maps on this phone.");
  });
});
