/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [O-1 · COORD 26 Oct] The courier rider calls the PARCEL RECIPIENT through Swift.
//
// The REAL rider ActiveJobScreen on a courier job, drawn by a real React
// renderer (the stand-ins of ActiveJobScreen.doorCash.navigation.test.ts), with
// the call switch answered by a fake GET /calls/config. Asserted:
//   - Bridge OFF (the launch state) or unreadable: exactly today. This app has
//     never shown or dialled the recipient's number (no build reads
//     courierRecipientPhone), so there is no recipient control at all; the
//     sender's Call still dials as before. These cases pass on the screen as
//     it was before this change too (the proof that OFF changed nothing).
//   - Bridge ON: a "Parcel recipient" card; its button asks Swift to call the
//     recipient (POST /calls/bridge target=recipient) and never dials a
//     number, even one a payload still carries. Refusals never offer a chat
//     with the recipient (they have none): the sender's chat, or support.
//   - Not a courier job: no recipient card.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  job: null as any,
  input: null as null | { onChangeText: (t: string) => void; value: string },
  code: null as null | { onChange: (t: string) => void },
  toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() },
  refetch: vi.fn(),
  navigate: vi.fn(),
  openExternal: vi.fn(async (_url: string, _fallback?: string) => true),
  config: vi.fn(),
  bridge: vi.fn(),
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
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
    Platform: { OS: 'ios' },
    Linking: { openURL: vi.fn() },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    __esModule: true,
    default: (p: any) => h('div', { 'data-map': '' }, p.children),
    Marker: (p: any) => h('div', { 'data-marker': p.title ?? '' }),
    Polyline: () => null,
    PROVIDER_DEFAULT: 'default',
  };
});
vi.mock('@gorhom/bottom-sheet', async () => {
  const R = await import('react');
  return { __esModule: true, default: (p: any) => R.createElement('section', null, p.children), BottomSheetScrollView: (p: any) => R.createElement('div', null, p.children) };
});
vi.mock('expo-image-picker', () => ({ requestCameraPermissionsAsync: vi.fn(), launchCameraAsync: vi.fn() }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const Box = (p: any) => h('div', a11y(p), p.children);
  const T = (p: any) => h('span', a11y(p), p.children);
  return {
    T, Eyebrow: T, PopupTitle: T, Screen: Box, DecorativeIcon: Box,
    PillButton: (p: any) => h('button', { type: 'button', 'data-testid': p.testID, 'aria-label': p.label, disabled: !!(p.disabled || p.loading), 'data-loading': p.loading ? 'true' : undefined, onClick: p.disabled || p.loading ? undefined : p.onPress }, p.label),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    EmptyState: (p: any) => h('div', null, p.title),
    StatusRail: () => null, LockIn: (p: any) => h('div', null, p.label), TonePill: (p: any) => h('span', null, p.label),
    // The door code boxes: only whether they read as refused matters here.
    CodeInput: (p: any) => {
      fx.code = p;
      return h('div', { 'data-testid': 'door-code', 'data-error': String(!!p.error) });
    },
    LabeledInput: (p: any) => {
      fx.input = p;
      return h('input', { 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, value: p.value, readOnly: true, 'data-error': p.error ?? '' });
    },
    ChoiceChip: (p: any) => h('button', { type: 'button', 'aria-label': p.label, 'aria-pressed': p.active ? 'true' : 'false', onClick: p.onPress }, p.label),
    cardShadow: {}, lockInButtonStyle: () => ({}),
  };
});
vi.mock('../../../kit/controls', () => ({ Stars: () => null }));
vi.mock('../../../kit/toast', () => ({ toast: fx.toast }));
vi.mock('../../../hooks', () => ({
  useMoverKind: () => ({ kind: 'RIDER' }),
  useActiveJob: () => ({ data: fx.job, refetch: fx.refetch, isFetching: false }),
  useActiveJobs: () => ({ legs: fx.job ? [fx.job] : [], run: null }),
  useDriverAction: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useRiderAction: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useRateCustomer: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierProof: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierCollect: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierPickupProof: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierReturn: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierReturnProof: () => ({ mutate: vi.fn(), isPending: false }),
  useDriverRouteLine: () => ({ data: null }),
}));
vi.mock('../../../hooks/mover', () => ({ uploadHandoverPhoto: vi.fn(), useTaxiStopAction: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../CustodyRecoverySection', () => ({ CustodyRecoverySection: () => null }));
vi.mock('../../safety/SosCeremony', () => ({ SosCeremony: () => null }));
vi.mock('../../../stores/moverPreview', () => ({ useMoverPreview: (select: (s: { preview: boolean }) => unknown) => select({ preview: false }) }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: 6.81, longitude: -58.15, status: 'granted' }) }));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn(), failure: vi.fn(), commit: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: fx.openExternal }));
vi.mock('../../../services/emergencyPolicy', () => ({ currentMarketDial: () => ({ kind: 'manual' }), emergencyDialCopy: () => '', previewEmergencyDial: () => null }));
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (select: (s: { countryCode: string }) => unknown) => select({ countryCode: 'GY' }),
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionForPrincipal: vi.fn(),
  requireAuthSessionSnapshot: vi.fn(),
}));
// The call switch and the bridge, as the API answers them (the Call control loads this lazily).
vi.mock('../../../services/api', () => ({ callsApi: { config: () => fx.config(), bridge: (orderId: string, target: string) => fx.bridge(orderId, target) } }));

import { ActiveJobScreen } from './ActiveJobScreen';
import { resetCallConfigForTests } from '../../../hooks/useCallParty';

/** Fictional numbers (never real): the sender's, and the one the sender typed for the recipient. */
const SENDER_PHONE = '+5920600001';
const RECIPIENT_PHONE = '+5920600002';
const OFF = { data: { success: true, data: { enabled: false, callerId: null } } };
const ON = { data: { success: true, data: { enabled: true, callerId: '+15005550006' } } };

/** A sender-pays courier job on its way to the recipient, as GET /rider/orders/active sends it. */
function courierJob(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-parcel-1',
    orderNumber: 'SW-2001',
    orderType: 'COURIER',
    status: 'PICKED_UP',
    paymentMethod: 'MMG',
    paymentStatus: 'PAID',
    courierPayer: 'SENDER',
    totalAmount: 1200,
    deliveryFee: 1200,
    tipAmount: 0,
    pickupLat: 6.80, pickupLng: -58.16, deliveryLat: 6.82, deliveryLng: -58.14,
    customer: { firstName: 'Asha', phone: SENDER_PHONE },
    courierRecipientPhone: RECIPIENT_PHONE,
    ...over,
  };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const navigation = { navigate: fx.navigate, goBack: vi.fn() };

async function render(job: unknown) {
  fx.job = job;
  await act(async () => root.render(React.createElement(ActiveJobScreen, { navigation })));
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
const text = () => host.textContent ?? '';
const named = (name: string) => host.querySelector(`[aria-label="${name}"]`) as HTMLElement | null;
async function click(el: Element | null) {
  expect(el, 'the control is on screen').toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
const refusal = (code: string) => ({ response: { status: 409, data: { success: false, error: { code, message: code } } } });

beforeEach(() => {
  vi.clearAllMocks();
  resetCallConfigForTests();
  fx.input = null;
  fx.code = null;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[O-1] bridge OFF (the launch state): the courier screen is exactly today\'s', () => {
  for (const [what, answer] of [['off', () => fx.config.mockResolvedValue(OFF)], ['unreadable', () => fx.config.mockRejectedValue(new Error('network'))]] as const) {
    it(`switch ${what}: no recipient control, the recipient's number never on screen, the sender's Call dials as before`, async () => {
      answer();
      await render(courierJob());
      expect(text()).not.toContain('Parcel recipient');
      expect(named('Call the parcel recipient via Swift')).toBeNull();
      expect(text()).not.toContain(RECIPIENT_PHONE);
      expect(text()).not.toContain(RECIPIENT_PHONE.slice(-7));
      // the one Call on the screen is the sender's, and it dials the sender as today
      const calls = Array.from(host.querySelectorAll('[aria-label="Call"]'));
      expect(calls).toHaveLength(1);
      await click(calls[0]!);
      expect(fx.openExternal).toHaveBeenCalledTimes(1);
      expect(fx.openExternal.mock.calls[0]![0]).toBe(`tel:${SENDER_PHONE}`);
      expect(fx.bridge).not.toHaveBeenCalled();
    });
  }
});

describe('[O-1] bridge ON: the courier rider has Swift call the parcel recipient', () => {
  beforeEach(() => { fx.config.mockResolvedValue(ON); });

  it('a "Parcel recipient" card whose button asks Swift to call the recipient (never a number)', async () => {
    fx.bridge.mockResolvedValue({ data: { success: true, data: { callId: 'c1', status: 'DIALING_CALLER' } } });
    // the server sends no number while the bridge is on; this payload still carries one: the app must not dial it
    await render(courierJob());
    expect(text()).toContain('Parcel recipient');
    expect(text()).toContain('Swift rings them about their delivery');
    expect(text()).not.toContain(RECIPIENT_PHONE);
    await click(named('Call the parcel recipient via Swift'));
    expect(fx.bridge).toHaveBeenCalledTimes(1);
    expect(fx.bridge).toHaveBeenCalledWith('ord-parcel-1', 'recipient');
    expect(fx.openExternal).not.toHaveBeenCalled();
    expect(fx.toast.success).toHaveBeenCalledTimes(1);
    expect(fx.toast.success.mock.calls[0]![0]).toBe('Swift is calling you now');
  });

  it('a refusal never offers a chat with the recipient (they have none): the sender\'s chat or support', async () => {
    for (const code of ['CALL_RELAY_OFF', 'CALL_ORDER_NOT_LIVE', 'CALL_LIMIT_REACHED', 'CALL_NO_NUMBER', 'SOMETHING_NEW']) {
      fx.toast.error.mockClear();
      fx.bridge.mockRejectedValueOnce(refusal(code));
      await render(courierJob({ courierRecipientPhone: null }));
      await click(named('Call the parcel recipient via Swift'));
      const words = String(fx.toast.error.mock.calls[0]?.[1] ?? '');
      expect(words, code).not.toMatch(/message them in chat/i);
      expect(words, code).toMatch(/sender|support|try again/i);
    }
  });

  it('a delivery from a store has no recipient card (its customer is the person at the door)', async () => {
    await render(courierJob({ orderType: 'DELIVERY', courierPayer: null, courierRecipientPhone: null, vendor: { name: 'Corner Shop' } }));
    expect(text()).not.toContain('Parcel recipient');
    expect(named('Call the parcel recipient via Swift')).toBeNull();
    // the customer's own Call is the bridge now
    expect(named('Call via Swift')).toBeTruthy();
  });
});
