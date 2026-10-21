/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

// ---------------------------------------------------------------------------
// [UI-SWEEP U09] The cart bar is a door BACK to the stack's own Tabs. In React
// Navigation 7 a plain navigate('Tabs', …) from a screen above Tabs PUSHES a
// second copy of the whole tab bar, so every store -> View cart loop grew the
// stack and Back walked through stale copies. Real stack + real tabs + the real
// CartBar; only native drawing, the cart read and the session are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
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
    Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) },
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
vi.mock('@swift/ui', () => ({ color: fx.token, elevation: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../hooks/customer', () => ({
  useCart: () => ({ data: { items: [{ itemId: 'i1', quantity: 2, vendorId: 'store-1' }], subtotalCustomer: 1500, vendorId: 'store-1' } }),
}));
vi.mock('../stores/authStore', () => ({ useAuthStore: (select: (s: { isAuthenticated: boolean }) => unknown) => select({ isAuthenticated: true }) }));
vi.mock('./money', async () => {
  const R = await import('react');
  return { Money: ({ amount }: any) => R.createElement('span', null, String(amount)) };
});
vi.mock('./text', async () => {
  const R = await import('react');
  return { T: ({ children }: any) => R.createElement('span', null, children) };
});

import { CartBar } from './cart-bar';

const nav = createNavigationContainerRef<Record<string, object | undefined>>();
const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();
const h = React.createElement;

const Home = () => h('p', null, 'home');
const Cart = () => h('p', null, 'cart');
const StoreCartBar = CartBar as (props: { vendorId?: string }) => React.ReactElement;
const Restaurant = () => h('section', null, h('p', null, 'store'), h(StoreCartBar, { vendorId: 'store-1' }));
const Tabs = () => h(Tab.Navigator, {
  screenOptions: { headerShown: false },
  children: [h(Tab.Screen, { key: 'Home', name: 'Home', component: Home }), h(Tab.Screen, { key: 'Cart', name: 'Cart', component: Cart })],
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function mount() {
  await act(async () => root.render(h(NavigationContainer as any, { ref: nav, linking: { enabled: false, prefixes: [] } },
    h(Stack.Navigator, {
      screenOptions: { headerShown: false },
      children: [h(Stack.Screen, { key: 'Tabs', name: 'Tabs', component: Tabs }), h(Stack.Screen, { key: 'Restaurant', name: 'Restaurant', component: Restaurant })],
    }))));
  expect(nav.isReady()).toBe(true);
}
const stackNames = () => nav.getRootState().routes.map((r) => r.name);
function viewCart() {
  // Screens below stay mounted in a native stack: the focused store's bar is the last one.
  const bars = [...host.querySelectorAll('button')].filter((b) => (b.getAttribute('aria-label') ?? '').startsWith('View cart'));
  expect(bars.length, 'a cart bar is on screen').toBeGreaterThan(0);
  return bars.at(-1)!;
}

describe('[UI-SWEEP U09] View cart goes back to the one tab bar', () => {
  it('store -> View cart leaves ONE Tabs and opens its Cart tab', async () => {
    await mount();
    await act(async () => nav.navigate('Restaurant'));
    expect(stackNames()).toEqual(['Tabs', 'Restaurant']);
    await act(async () => viewCart().click());
    expect(stackNames(), 'no second copy of the tab bar').toEqual(['Tabs']);
    expect(nav.getCurrentRoute()?.name).toBe('Cart');
  });

  it('repeated store -> cart loops never grow the stack', async () => {
    await mount();
    for (let loop = 0; loop < 3; loop++) {
      await act(async () => nav.navigate('Restaurant'));
      await act(async () => viewCart().click());
    }
    expect(stackNames()).toEqual(['Tabs']);
    expect(nav.getCurrentRoute()?.name).toBe('Cart');
  });
});
