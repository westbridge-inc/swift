/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';


// ---------------------------------------------------------------------------
// [BUG-GUARDS C3 · #1951 review S3-1] The active-job screen never tells a
// driver or rider "No active job" before the job read has answered.
//
// The REAL ActiveJobScreen drawn by a real React renderer (the same stand-ins
// as ActiveJobScreen.sos.navigation.test.ts: native drawing, the kit, storage;
// the job hook is a stand-in whose read state each case sets). Asserted: a
// failed read with nothing cached says so and offers Try again (which asks
// again) and Back; a read still loading shows a spinner; only a read that
// answered "no job" says "No active job".
// ---------------------------------------------------------------------------


const fx = vi.hoisted(() => {
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  return {
    kind: 'DRIVER' as 'DRIVER' | 'RIDER',
    job: null as any,
    active: { data: undefined as unknown, isLoading: false, isError: false },
    refetch: vi.fn(async () => undefined),
    preview: false,
    routes: {} as Record<string, (config: any) => any>,
    seen: [] as any[],
    storage: new Map<string, string>(),
    openExternal: vi.fn(async (_url: string, _fallback?: string) => true),
    dial: { kind: 'auto', number: '911' } as { kind: 'auto' | 'confirm'; number: string } | { kind: 'manual' },
  };
});

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const View = (p: any) => h('div', a11y(p), p.children);
  const Pressable = (p: any) => h('div', { ...a11y(p), role: p.accessibilityRole ?? 'button', onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View, Pressable, Text: View, ScrollView: View, Image: View, ActivityIndicator: () => null,
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
    TurboModuleRegistry: { get: () => null },
    Linking: { openURL: vi.fn(async () => true) },
    AppState: { addEventListener: () => ({ remove() {} }), currentState: 'active' },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
  };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  return { __esModule: true, default: (p: any) => R.createElement('div', { 'data-map': '' }, p.children), Marker: () => null, Polyline: () => null, PROVIDER_DEFAULT: 'default' };
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
    PillButton: (p: any) => h('button', { type: 'button', 'data-testid': p.testID, 'aria-label': p.label, disabled: !!(p.disabled || p.loading), onClick: p.disabled || p.loading ? undefined : p.onPress }, p.label),
    // The real PopupCard: a tap on the dim backdrop (or Android back) calls onClose.
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, h('div', { 'data-testid': 'popup-backdrop', onClick: p.onClose }), p.children) : null),
    EmptyState: (p: any) => h('div', null, p.title),
    ErrorState: (p: any) => h('div', { role: 'alert' }, p.message, p.onRetry ? h('button', { type: 'button', onClick: p.onRetry }, 'Try again') : null),
    Spinner: () => h('div', { 'data-testid': 'spinner' }),
    StatusRail: () => null, LockIn: (p: any) => h('div', null, p.label), CodeInput: () => null, TonePill: (p: any) => h('span', null, p.label),
    cardShadow: {}, lockInButtonStyle: () => ({}),
  };
});
vi.mock('../../../kit/controls', () => ({ Stars: () => null }));
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() } }));
// The screen's job and step hooks are stand-ins; the SOS hooks are the REAL ones.
vi.mock('../../../hooks', async () => {
  const rides = await vi.importActual<typeof import('../../../hooks/rides')>('../../../hooks/rides');
  const idle = () => ({ mutate: vi.fn(), isPending: false, isError: false });
  return {
    useMoverKind: () => ({ kind: fx.kind }),
    useActiveJob: () => ({ ...fx.active, refetch: fx.refetch, isFetching: false }),
    useActiveJobs: () => ({ legs: [], run: null }),
    useDriverAction: idle, useRiderAction: idle, useRateCustomer: idle,
    useCourierProof: idle, useCourierCollect: idle, useCourierPickupProof: idle, useCourierReturn: idle, useCourierReturnProof: idle,
    useRideSos: rides.useRideSos,
    // [TAXI route line] No road: the map keeps its straight heading line.
    useDriverRouteLine: () => ({ data: null }),
  };
});
vi.mock('../../../hooks/customer', () => ({ customerKeys: { homeAll: ['customer', 'home'] } }));
vi.mock('../../../hooks/mover', () => ({ uploadHandoverPhoto: vi.fn(), useTaxiStopAction: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../CustodyRecoverySection', () => ({ CustodyRecoverySection: () => null }));
vi.mock('../../../stores/moverPreview', () => ({ useMoverPreview: (select: (s: { preview: boolean }) => unknown) => select({ preview: fx.preview }) }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: 6.81, longitude: -58.15, status: 'granted' }) }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) } }));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn(), failure: vi.fn(), commit: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: fx.openExternal }));
vi.mock('../../../lib/storage', () => ({
  zustandStorage: {
    getItem: (k: string) => fx.storage.get(k) ?? null,
    setItem: (k: string, v: string) => { fx.storage.set(k, v); },
    removeItem: (k: string) => { fx.storage.delete(k); },
  },
}));
// Guyana's verified number (the bundled market policy's answer), served without a fetch.
vi.mock('../../../services/emergencyPolicy', () => ({
  useEmergencyPolicy: () => ({ country: 'GY', dial: fx.dial }),
  emergencyDialFor: () => fx.dial,
  currentMarketDial: () => fx.dial,
  previewEmergencyDial: () => fx.dial,
  emergencyDialCopy: (dial: { kind: string; number?: string }) => (dial.kind === 'manual' ? 'Dial your local emergency services first.' : `This dials ${dial.number}.`),
}));
vi.mock('../../../stores/authStore', () => {
  const state = { isAuthenticated: true, countryCode: 'GY', user: { id: 'mover-1', firstName: 'Devon' }, sessionGeneration: 1 };
  const useAuthStore = Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => ({ ...state, rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }),
  });
  const session = () => ({ userId: 'mover-1', generation: 1, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' });
  return {
    useAuthStore,
    AuthSessionBoundaryError: class extends Error {},
    getAuthSessionSnapshot: session,
    requireAuthSessionSnapshot: session,
    requireAuthSessionForPrincipal: session,
    isAuthSessionSnapshotCurrent: () => true,
  };
});

// The ed25519 verifier of the emergency policy is a stand-in too: the policy itself is the stand-in above,
// so nothing on this screen's path verifies a signature.
vi.mock('../../../lib/emergencyPolicySignature', () => ({
  EMERGENCY_ENVELOPE_MESSAGE_PREFIX: 'swift.emergency-policy.v2', MAX_EMERGENCY_POLICY_LIFETIME_MS: 86_400_000, MAX_EMERGENCY_POLICY_CLOCK_AHEAD_MS: 900_000,
  emergencyEnvelopeMessage: () => new Uint8Array(), canonicalEmergencyPayload: () => '', verifyEmergencyEnvelope: () => null,
}));
import { ActiveJobScreen } from './ActiveJobScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const navigation = { navigate: vi.fn(), goBack: vi.fn() };

async function render(active: { data: unknown; isLoading: boolean; isError: boolean }) {
  fx.kind = 'DRIVER';
  fx.job = null;
  fx.active = active;
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(ActiveJobScreen, { navigation }))));
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
const text = () => host.textContent ?? '';
const button = (name: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name || b.getAttribute('aria-label') === name) ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe('the active-job screen before the job read answers', () => {
  it('a failed read with nothing cached says so, asks again on Try again, and keeps Back — never "No active job"', async () => {
    await render({ data: undefined, isLoading: false, isError: true });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("We couldn't load your job");
    expect(text()).not.toContain('No active job');
    await act(async () => { button('Try again')!.click(); });
    expect(fx.refetch).toHaveBeenCalledTimes(1);
    await act(async () => { button('Back')!.click(); });
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('a read still loading shows the spinner and Back — never "No active job"', async () => {
    await render({ data: undefined, isLoading: true, isError: false });
    expect(host.querySelector('[data-testid="spinner"]')).toBeTruthy();
    expect(text()).not.toContain('No active job');
    expect(button('Back')).toBeTruthy();
  });

  it('only a read that answered "no job" says "No active job" (control)', async () => {
    await render({ data: null, isLoading: false, isError: false });
    expect(text()).toContain('No active job');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[data-testid="spinner"]')).toBeNull();
  });

  it('a failed background refresh with nothing to show still says "No active job" only once the read had answered (control)', async () => {
    await render({ data: null, isLoading: false, isError: true });
    expect(text()).toContain('No active job');
  });
});
