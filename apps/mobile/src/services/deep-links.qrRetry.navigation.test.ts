/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// ---------------------------------------------------------------------------
// [UI-SWEEP U30] A store QR that failed ("Could not connect to this store")
// and then lands on Retry REPLACES that failure with the store: Back from the
// store never returns to a failure that is no longer true. The real deep-link
// handler drives the real navigationRef on a real root stack; only the
// network, native drawing and analytics are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  get: vi.fn(),
  listener: null as null | ((event: { url: string }) => void),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, typeof children === 'function' ? children({ pressed: false }) : children);
  const Pressable = ({ children, onPress, accessibilityLabel }: any) =>
    R.createElement('button', { type: 'button', 'aria-label': accessibilityLabel, onClick: onPress }, typeof children === 'function' ? children({ pressed: false }) : children);
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, Image: View, Pressable,
    Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
    I18nManager: { getConstants: () => ({ isRTL: false }) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { Value, View, timing: animation, spring: animation, parallel: animation, add: () => new Value(), multiply: () => new Value() },
    Easing: { inOut: (fn: unknown) => fn, in: (fn: unknown) => fn, out: (fn: unknown) => fn, ease: () => 0, linear: () => 0, poly: () => () => 0 },
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 1 }),
    Keyboard: { addListener: () => ({ remove() {} }) }, AppState: { addEventListener: () => ({ remove() {} }) },
    Linking: { getInitialURL: async () => null, addEventListener: (_type: string, listener: (event: { url: string }) => void) => { fx.listener = listener; return { remove() {} }; } },
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
vi.mock('./api', () => ({ api: { get: fx.get, post: vi.fn(async () => ({})) } }));
vi.mock('../kit/toast', () => ({ toast: { show: vi.fn() } }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));

import { navigationRef } from '../navigation/navigationRef';
import { flushPendingDeepLink, installDeepLinkHandler, resetDeepLinksForTests, retryQrDestination } from './deep-links';
import { setLinkPolicyForTests } from '../lib/deepLinkParse';
import { policyFrom } from '../lib/linkPolicy';

const Root = createNativeStackNavigator();
const Store = createNativeStackNavigator();
const h = React.createElement;
const Home = () => h('p', null, 'home');
const QrOutcome = () => h('p', null, 'Could not connect to this store');
const Restaurant = () => h('p', null, 'store');
const Storefront = () => h(Store.Navigator, {
  screenOptions: { headerShown: false },
  children: h(Store.Screen, { name: 'Restaurant', component: Restaurant }),
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let uninstall: (() => void) | undefined;
const offline = () => Promise.reject(new Error('Network Error'));
const store = (vendorId: string) => Promise.resolve({ data: { data: { verdict: 'WEB_RENDER', vendorId } } });
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const stack = () => navigationRef.getRootState().routes.map((r) => r.name);
const current = () => navigationRef.getCurrentRoute();

beforeEach(async () => {
  vi.clearAllMocks();
  resetDeepLinksForTests();
  setLinkPolicyForTests(policyFrom({ webUrl: 'https://swiftgy.com', isDev: false }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(h(NavigationContainer as any, { ref: navigationRef, linking: { enabled: false, prefixes: [] } },
    h(Root.Navigator, {
      screenOptions: { headerShown: false },
      children: [
        h(Root.Screen, { key: 'Home', name: 'Home', component: Home }),
        h(Root.Screen, { key: 'QrOutcome', name: 'QrOutcome', component: QrOutcome }),
        h(Root.Screen, { key: 'Storefront', name: 'Storefront', component: Storefront }),
      ],
    }))));
  expect(navigationRef.isReady()).toBe(true);
  uninstall = installDeepLinkHandler();
  flushPendingDeepLink();
  await settle();
});
afterEach(async () => {
  uninstall?.();
  await act(async () => root.unmount());
  host.remove();
});

async function scanWhileOffline() {
  fx.get.mockImplementationOnce(offline);
  act(() => fx.listener!({ url: 'https://swiftgy.com/s/BCDFGHJKMN' }));
  await settle();
  expect(stack()).toEqual(['Home', 'QrOutcome']);
  return current()!.params as { reason: string; destination: any; requestId: number };
}

describe('[UI-SWEEP U30] a QR retry that lands replaces the failure it was tapped on', () => {
  it('Retry -> the store REPLACES "Could not connect"; Back goes to where the scan started', async () => {
    const outcome = await scanWhileOffline();
    expect(outcome.reason).toBe('offline');
    fx.get.mockImplementationOnce(() => store('short-store'));
    await act(async () => { await retryQrDestination(outcome.destination, outcome.requestId); });
    await settle();
    expect(stack()).toEqual(['Home', 'Storefront']);
    expect(current()).toMatchObject({ name: 'Restaurant', params: { vendorId: 'short-store' } });
    await act(async () => navigationRef.goBack());
    expect(current()?.name).toBe('Home');
  });

  it('a scan that lands first time is pushed as before (nothing to replace)', async () => {
    fx.get.mockImplementationOnce(() => store('short-store'));
    act(() => fx.listener!({ url: 'https://swiftgy.com/s/BCDFGHJKMN' }));
    await settle();
    expect(stack()).toEqual(['Home', 'Storefront']);
    expect(current()).toMatchObject({ name: 'Restaurant', params: { vendorId: 'short-store' } });
  });

  it('[#1907 review S4-2] a retry that lands after the customer left "Could not connect" never replaces the screen they are on', async () => {
    const outcome = await scanWhileOffline();
    let land!: (v: unknown) => void;
    fx.get.mockImplementationOnce(() => new Promise((resolve) => { land = resolve; }));
    let retry!: Promise<unknown>;
    act(() => { retry = retryQrDestination(outcome.destination, outcome.requestId); });
    await act(async () => navigationRef.goBack());
    expect(stack()).toEqual(['Home']);
    await act(async () => { land({ data: { data: { verdict: 'WEB_RENDER', vendorId: 'short-store' } } }); await retry; });
    await settle();
    expect(stack(), 'the store opens OVER Home: the late answer never replaces the screen the customer is on').toEqual(['Home', 'Storefront']);
    await act(async () => navigationRef.goBack());
    expect(current()?.name).toBe('Home');
  });
});
