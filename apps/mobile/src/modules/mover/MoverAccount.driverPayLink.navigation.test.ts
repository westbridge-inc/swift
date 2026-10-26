/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] Passengers pay the driver directly at
// drop-off, cash or MMG: there is no in-app MMG pay link. The REAL mover Account
// screen shows the "Your MMG pay link" card only while the server says the link
// is on (driver profile `mmgPayLinkEnabled === true`, the DRIVER_MMG_PAY_LINK
// switch). Off, or an older server that does not say, means no card.
// Only native drawing, data hooks and unrelated screens are stand-ins.
const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
  profile: { isOnline: false } as Record<string, unknown>,
}));
vi.mock('../profile/screens/PersonalDataScreen', () => ({ PersonalDataScreen: 'PersonalDataScreen' }));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, typeof children === 'function' ? children({ pressed: false }) : children);
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, Image: View, Pressable: View, RefreshControl: View,
    Modal: ({ visible, children }: any) => visible ? R.createElement(View, null, children) : null,
    Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
    I18nManager: { getConstants: () => ({ isRTL: false }) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { Value, View, timing: animation, spring: animation, parallel: animation, add: () => new Value(), multiply: () => new Value() },
    Easing: { inOut: (fn: unknown) => fn, in: (fn: unknown) => fn, out: (fn: unknown) => fn, ease: () => 0, linear: () => 0, poly: () => () => 0 },
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 1 }),
    Keyboard: { addListener: () => ({ remove() {} }) }, Vibration: { vibrate: vi.fn() }, AppState: { addEventListener: () => ({ remove() {} }) },
    Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) }, Share: { share: vi.fn() },
  };
});
vi.mock('@react-navigation/elements', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  const SafeAreaProviderCompat = Object.assign(Box, { initialMetrics: { frame: { width: 390, height: 844 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } } });
  return {
    SafeAreaProviderCompat, Screen: Box, Header: () => null, HeaderBackButton: () => null,
    HeaderBackContext: R.createContext(undefined), HeaderShownContext: R.createContext(false),
    HeaderHeightContext: R.createContext(0), useHeaderHeight: () => 0,
    getHeaderTitle: (_options: unknown, name: string) => name, getLabel: (options: any, fallback: string) => options.label ?? fallback,
    PlatformPressable: Box, Label: Box, Background: Box, Badge: () => null, MissingIcon: () => null,
    useFrameSize: () => ({ width: 390, height: 844 }), useLocale: () => ({ direction: 'ltr' }),
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const R = await import('react');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return { SafeAreaInsetsContext: R.createContext(insets), useSafeAreaInsets: () => insets, SafeAreaProvider: ({ children }: any) => children };
});
vi.mock('react-native-screens', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { screensEnabled: () => false, Screen: Box, ScreenContainer: Box };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: vi.fn(), launchImageLibraryAsync: vi.fn(), MediaTypeOptions: { Images: 'Images' } }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  const Button = ({ label, onPress }: any) => R.createElement('button', { type: 'button', onClick: onPress }, label);
  return {
    Card: Box, Screen: Box, T: Box, Header: () => null, LinkText: () => null, PillButton: Button, TonePill: () => null,
    LoadingBlock: () => null, SettingsRow: Button,
    useLogoutConfirm: () => ({ requestLogout: vi.fn(), logoutDialog: null }),
  };
});
vi.mock('../../kit/controls', () => ({ Stars: () => null }));
vi.mock('../../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../../components/MmgPayLinkCard', async () => {
  const R = await import('react');
  return { MmgPayLinkCard: () => R.createElement('section', { 'data-card': 'mmg-pay-link' }, 'Your MMG pay link') };
});
vi.mock('../../components/StandingCard', () => ({ StandingCard: () => null }));
vi.mock('./DeliveriesTooCard', () => ({ DeliveriesTooCard: () => null })); // [CARS-DELIVER] its own test: MoverAccount.deliveriesToo
vi.mock('../../components/billing/BillingSurfaces', () => ({ BillingStatusBlock: () => null, BillingStopControl: () => null }));
vi.mock('../../components/RoleSwitcherSheet', () => ({ RoleSwitcherSheet: () => null }));
vi.mock('../../components/onboarding/WentLive', () => ({ useWentLive: () => ({ celebrate: false, dismiss: () => undefined }), WentLivePopup: () => null }));
vi.mock('../../hooks/useStepUp', () => ({ useStepUp: () => ({ withStepUp: (fn: unknown) => fn, sheet: null, active: false }) }));
vi.mock('../../hooks', () => {
  const read = { data: undefined, isLoading: false };
  const write = { mutate: vi.fn(), isPending: false, isError: false };
  return {
    useActiveJob: () => ({ data: null }), useBroadcastLocation: () => undefined,
    useMoverKind: () => ({ kind: 'DRIVER', profile: fx.profile }),
    useVerificationStatus: () => ({ data: { roleVerified: true }, isLoading: false }),
    useMoverStanding: () => read, useEarningsSummary: () => read, useMoverSubscription: () => read,
    useSetMoverBillingMethod: () => write, useUploadVehiclePhoto: () => write,
  };
});
vi.mock('../../stores/authStore', () => {
  const state = { user: { firstName: 'Synthetic', lastName: 'Mover', phone: '' }, setIntent: vi.fn() };
  return {
    AuthSessionBoundaryError: class extends Error {},
    requireAuthSessionSnapshot: vi.fn(), requireAuthSessionForPrincipal: vi.fn(), getAuthSessionSnapshot: () => null,
    useAuthStore: (selector?: (s: typeof state) => unknown) => selector ? selector(state) : state,
  };
});
vi.mock('../../services/api', () => ({ API_URL: 'https://example.test', driverApi: {}, riderApi: {} }));
vi.mock('../chat/screens/ConversationScreen', () => ({ ConversationScreen: () => null }));
vi.mock('../billing/screens/WeeklyFeeRouteScreen', () => ({ WeeklyFeeRouteScreen: () => null }));
vi.mock('../profile/screens/GetHelpScreen', () => ({ GetHelpScreen: () => null }));
vi.mock('../safety/screens/LivenessCheckScreen', () => ({ LivenessCheckScreen: () => null }));
vi.mock('../safety/screens/GuardianDriverConfirmScreen', () => ({ GuardianDriverConfirmScreen: () => null }));
vi.mock('./screens/MoverHomeScreen', () => ({ MoverHomeScreen: () => null }));
vi.mock('./screens/ActiveJobScreen', () => ({ ActiveJobScreen: () => null }));
vi.mock('./screens/EarningsScreen', () => ({ EarningsScreen: () => null }));
vi.mock('./screens/ClaimsScreen', () => ({ ClaimsScreen: () => null }));
vi.mock('./screens/JobHistoryScreen', () => ({ JobHistoryScreen: () => null }));
vi.mock('./screens/MoverDocumentsScreen', () => ({ MoverDocumentsScreen: () => null }));
vi.mock('./screens/MoverVehicleScreen', () => ({ MoverVehicleScreen: () => null }));
vi.mock('./screens/MoverOnboardingScreen', () => ({ MoverOnboardingScreen: () => null }));

import { MoverAccountScreen } from './screens/MoverAccountScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function renderAccount(profile: Record<string, unknown>) {
  fx.profile = profile;
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: new QueryClient() },
    React.createElement(NavigationContainer<Record<string, object | undefined>>, {
      linking: { enabled: false, prefixes: [] }, children: React.createElement(MoverAccountScreen, { navigation: { navigate: vi.fn() } }),
    }))));
}
const card = () => host.querySelector('[data-card="mmg-pay-link"]');

describe('[PAYMENT-SIMPLIFY] the driver MMG pay link card follows the server switch', () => {
  it('switch off: no card, even with a stored link', async () => {
    await renderAccount({ isOnline: false, mmgPayLinkEnabled: false, mmgPayUrl: null });
    expect(host.textContent).toContain('Earnings'); // the screen rendered
    expect(card()).toBeNull();
  });

  it('an older server that does not say: no card (off is the default)', async () => {
    await renderAccount({ isOnline: false, mmgPayUrl: 'https://pay.example.com/pay/legacy' });
    expect(host.textContent).toContain('Earnings');
    expect(card()).toBeNull();
  });

  it('switch on (DRIVER_MMG_PAY_LINK=1): the card is back', async () => {
    await renderAccount({ isOnline: false, mmgPayLinkEnabled: true, mmgPayUrl: null });
    expect(card()).not.toBeNull();
  });
});
