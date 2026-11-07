/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The REAL MoverStack and its root in a real NavigationContainer. An account whose documents were approved before a
// vehicle was saved holds no rider or driver profile: the vehicle form lives on the onboarding screen, so that screen is
// where it belongs, never the home screen's "profile isn't ready" with a Retry that can never work. Only native
// drawing, data hooks and the screens themselves are stand-ins.
const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
  status: undefined as unknown,
  live: [] as Array<boolean | undefined>,
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
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { LoadingBlock: () => null, Screen: Box, T: Box };
});
vi.mock('../../hooks', () => ({
  useActiveJob: () => ({ data: null }),
  useBroadcastLocation: () => undefined,
  useMoverKind: () => ({ kind: null, profile: null }),
  useVerificationStatus: () => ({ data: fx.status, isLoading: false }),
}));
vi.mock('../../hooks/moverJobFeed', () => ({ useMoverJobFeed: () => undefined }));
vi.mock('../../stores/authStore', () => ({
  getAuthSessionSnapshot: () => null,
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ setIntent: vi.fn() }),
}));
vi.mock('../../services/api', () => ({ API_URL: 'https://example.test', driverApi: {}, riderApi: {} }));
// What the went-live popup is asked: it celebrates a false that turns true, so it must never hear a false "live".
vi.mock('../../components/onboarding/WentLive', () => ({
  useWentLive: (isLive: boolean | undefined) => { fx.live.push(isLive); return { celebrate: false, dismiss: () => undefined }; },
  WentLivePopup: () => null,
}));
vi.mock('../chat/screens/ConversationScreen', () => ({ ConversationScreen: () => null }));
vi.mock('../billing/screens/WeeklyFeeRouteScreen', () => ({ WeeklyFeeRouteScreen: () => null }));
vi.mock('../profile/screens/GetHelpScreen', () => ({ GetHelpScreen: () => null }));
vi.mock('../safety/screens/LivenessCheckScreen', () => ({ LivenessCheckScreen: () => null }));
vi.mock('../safety/screens/GuardianDriverConfirmScreen', () => ({ GuardianDriverConfirmScreen: () => null }));
vi.mock('./screens/ActiveJobScreen', () => ({ ActiveJobScreen: () => null }));
vi.mock('./screens/EarningsScreen', () => ({ EarningsScreen: () => null }));
vi.mock('./screens/ClaimsScreen', () => ({ ClaimsScreen: () => null }));
vi.mock('./screens/JobHistoryScreen', () => ({ JobHistoryScreen: () => null }));
vi.mock('./screens/MoverAccountScreen', () => ({ MoverAccountScreen: () => null }));
vi.mock('./screens/MoverDocumentsScreen', () => ({ MoverDocumentsScreen: () => null }));
vi.mock('./screens/MoverVehicleScreen', () => ({ MoverVehicleScreen: () => null }));
vi.mock('./MoverNoAnswer', () => ({ MoverNoAnswer: () => 'NO ANSWER' }));
vi.mock('./screens/MoverOnboardingScreen', () => ({ MoverOnboardingScreen: () => 'ONBOARDING' }));
vi.mock('./screens/MoverHomeScreen', () => ({ MoverHomeScreen: () => 'HOME' }));

import { navigationRef as navigation } from '../../navigation/navigationRef';
import { MoverStack } from './MoverStack';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { fx.live.length = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const mount = (status: unknown) => {
  fx.status = status;
  return act(async () => root.render(React.createElement(QueryClientProvider, { client: new QueryClient() },
    React.createElement(NavigationContainer<Record<string, object | undefined>>, {
      ref: navigation, linking: { enabled: false, prefixes: [] }, children: React.createElement(MoverStack),
    }))));
};

describe('the mover root reads documents AND a saved vehicle', () => {
  it('documents approved, no vehicle saved: the vehicle form, and no "you are live" popup', async () => {
    await mount({ roleVerified: true, vehicleType: null });
    expect(host.textContent).toContain('ONBOARDING');
    expect(host.textContent).not.toContain('HOME');
    expect(fx.live.at(-1)).toBe(false);
  });

  it('documents approved, vehicle saved: home', async () => {
    await mount({ roleVerified: true, vehicleType: 'MOTORCYCLE' });
    expect(host.textContent).toContain('HOME');
    expect(fx.live.at(-1)).toBe(true);
  });

  it('documents not approved: the vehicle form, as ever', async () => {
    await mount({ roleVerified: false, vehicleType: 'MOTORCYCLE' });
    expect(host.textContent).toContain('ONBOARDING');
    expect(fx.live.at(-1)).toBe(false);
  });

  it('a server that does not name a vehicle at all keeps today\'s answer', async () => {
    await mount({ roleVerified: true });
    expect(host.textContent).toContain('HOME');
  });
});
