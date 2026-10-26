/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// [CARS-DELIVER · owner 8 + 25 Oct 2026] "Deliveries too" on the REAL mover Account screen. A taxi driver's car
// can also take store deliveries, behind the server's CAR_DELIVERIES switch (OFF until counsel verifies goods
// carriage). The card follows GET /driver/deliveries only: nothing while the server says the switch is off, an
// older server (404) or a failed read; "Add deliveries" when it can be set up (POST /driver/deliveries); the
// work-mode switch once it is; an honest "paused" line if the switch went off after set-up.
// Only native drawing, data hooks, the server and unrelated screens are stand-ins.
const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
  profile: { isOnline: false } as Record<string, unknown>,
  kind: 'DRIVER' as 'DRIVER' | 'RIDER',
  dual: false,
  status: null as unknown,
  statusError: null as unknown,
  carDeliveries: vi.fn(),
  addCarDeliveries: vi.fn(),
  selectKind: vi.fn(),
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
vi.mock('../../components/billing/BillingSurfaces', () => ({ BillingStatusBlock: () => null, BillingStopControl: () => null }));
vi.mock('../../components/RoleSwitcherSheet', () => ({ RoleSwitcherSheet: () => null }));
vi.mock('../../components/onboarding/WentLive', () => ({ useWentLive: () => ({ celebrate: false, dismiss: () => undefined }), WentLivePopup: () => null }));
vi.mock('../../hooks/useStepUp', () => ({ useStepUp: () => ({ withStepUp: (fn: unknown) => fn, sheet: null, active: false }) }));
vi.mock('../../hooks', () => {
  const read = { data: undefined, isLoading: false };
  const write = { mutate: vi.fn(), isPending: false, isError: false };
  return {
    useActiveJob: () => ({ data: null }), useBroadcastLocation: () => undefined,
    useMoverKind: () => ({ kind: fx.kind, profile: fx.profile, dual: fx.dual }),
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
vi.mock('../../services/api', () => ({
  API_URL: 'https://example.test', riderApi: {},
  driverApi: { carDeliveries: fx.carDeliveries, addCarDeliveries: fx.addCarDeliveries },
}));
vi.mock('../../hooks/mover', () => ({ useSelectMoverKind: () => ({ mutate: fx.selectKind, isPending: false, isError: false, error: null }) }));
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
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  fx.kind = 'DRIVER'; fx.dual = false; fx.status = null; fx.statusError = null;
  fx.carDeliveries.mockReset().mockImplementation(async () => {
    if (fx.statusError) throw fx.statusError;
    return { data: { success: true, data: fx.status } };
  });
  fx.addCarDeliveries.mockReset().mockResolvedValue({ data: { success: true, data: { available: true, enabled: true, reason: null } } });
  fx.selectKind.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const hop = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function renderAccount() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    React.createElement(NavigationContainer<Record<string, object | undefined>>, {
      linking: { enabled: false, prefixes: [] }, children: React.createElement(MoverAccountScreen, { navigation: { navigate: vi.fn() } }),
    }))));
  await act(async () => { await hop(); });
}
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
const press = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  expect(button, `no "${label}" button in: ${buttons().join(' | ')}`).toBeTruthy();
  await act(async () => { button!.click(); await hop(); });
};

describe('[CARS-DELIVER] "Deliveries too" on the mover account follows the server', () => {
  it('switch off: no card, no words about deliveries by car (and the server was asked)', async () => {
    fx.status = { available: false, enabled: false, reason: 'SWITCH_OFF', vehicle: { type: 'CAR', label: 'Car' } };
    await renderAccount();
    expect(host.textContent).toContain('Earnings'); // the screen rendered
    expect(fx.carDeliveries).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain('Deliveries too');
    expect(host.textContent).not.toContain('Take deliveries too');
    expect(buttons()).not.toContain('Add deliveries');
  });

  it('an older server (404) or a failed read: no card', async () => {
    fx.statusError = Object.assign(new Error('Not found'), { response: { status: 404 } });
    await renderAccount();
    expect(host.textContent).toContain('Earnings');
    expect(fx.carDeliveries).toHaveBeenCalled();
    expect(host.textContent).not.toContain('deliveries too');
    expect(host.textContent).not.toContain('Deliveries too');
  });

  it('switch on: a taxi driver is offered "Add deliveries" in plain words, and the tap sets it up', async () => {
    fx.status = { available: true, enabled: false, reason: null, vehicle: { type: 'WAGON_CAR', label: 'Wagon Car' } };
    await renderAccount();
    expect(host.textContent).toContain('Take deliveries too');
    expect(host.textContent).toContain('Use your wagon car for store deliveries as well as taxi rides. Adding deliveries does not change your weekly fee, and you keep 100%.');
    await press('Add deliveries');
    expect(fx.addCarDeliveries).toHaveBeenCalledTimes(1);
  });

  it('set up: the card switches work mode — to deliveries from taxi mode, back to taxi rides from delivery mode', async () => {
    fx.status = { available: true, enabled: true, reason: null, vehicle: { type: 'CAR', label: 'Car' } };
    fx.dual = true;
    await renderAccount();
    expect(host.textContent).toContain('Your car can take store deliveries as well as taxi rides — one at a time.');
    expect(buttons()).not.toContain('Add deliveries');
    await press('Switch to deliveries');
    expect(fx.selectKind).toHaveBeenCalledWith('RIDER');

    await act(async () => root.unmount());
    root = createRoot(host);
    fx.kind = 'RIDER';
    await renderAccount();
    await press('Switch to taxi rides');
    expect(fx.selectKind).toHaveBeenLastCalledWith('DRIVER');
  });

  it('set up, then the switch goes off: an honest paused line, no switch button', async () => {
    fx.status = { available: false, enabled: true, reason: 'SWITCH_OFF', vehicle: { type: 'CAR', label: 'Car' } };
    fx.dual = true;
    await renderAccount();
    expect(host.textContent).toContain('Deliveries by taxi car are paused on Swift for now. Taxi rides work as usual.');
    expect(buttons()).not.toContain('Switch to deliveries');
  });

  it('a delivery-only rider (no taxi profile) is never asked about it', async () => {
    fx.kind = 'RIDER';
    fx.dual = false;
    fx.status = { available: true, enabled: false, reason: null, vehicle: { type: 'CAR', label: 'Car' } };
    await renderAccount();
    expect(host.textContent).toContain('Earnings');
    expect(fx.carDeliveries).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('deliveries too');
  });
});
