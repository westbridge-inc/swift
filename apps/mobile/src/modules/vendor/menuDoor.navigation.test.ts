/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef, useNavigation } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

// ---------------------------------------------------------------------------
// [UI-SWEEP U29] The business board's doors to the menu list go BACK to the
// Menu tab's own list. Real tabs + the real nested Menu stack shape
// (VendorStack MenuStackNav: VendorMenu, VendorItemEditor) + the real door;
// only native drawing is a stand-in.
// ---------------------------------------------------------------------------

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

import { openMenuList } from './menuDoor';

const nav = createNavigationContainerRef<Record<string, object | undefined>>();
const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();
const h = React.createElement;

function Board() {
  const navigation = useNavigation<any>();
  return h('section', null,
    h('button', { type: 'button', onClick: () => openMenuList(navigation) }, 'Menu & inventory'),
    // The shape main shipped, kept as the control that shows the stack growing.
    h('button', { type: 'button', onClick: () => navigation.navigate('Menu', { screen: 'VendorMenu' }) }, 'plain navigate'));
}
const VendorMenu = () => h('p', null, 'menu list');
const VendorItemEditor = () => h('p', null, 'item editor');
const MenuStack = () => h(Stack.Navigator, {
  screenOptions: { headerShown: false },
  children: [
    h(Stack.Screen, { key: 'VendorMenu', name: 'VendorMenu', component: VendorMenu }),
    h(Stack.Screen, { key: 'VendorItemEditor', name: 'VendorItemEditor', component: VendorItemEditor }),
  ],
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function mount() {
  await act(async () => root.render(h(NavigationContainer as any, { ref: nav, linking: { enabled: false, prefixes: [] } },
    h(Tab.Navigator, {
      screenOptions: { headerShown: false },
      children: [
        h(Tab.Screen, { key: 'Home', name: 'Home', component: Board }),
        h(Tab.Screen, { key: 'Menu', name: 'Menu', component: MenuStack }),
      ],
    }))));
  expect(nav.isReady()).toBe(true);
}
const tab = () => nav.getRootState().routes[nav.getRootState().index]!.name;
const menuStack = () => (nav.getRootState().routes.find((r) => r.name === 'Menu')?.state?.routes ?? []).map((r) => r.name);
async function leaveAnEditorOpen() {
  // The owner opens the Menu tab, taps an item, then leaves for the board.
  await act(async () => nav.navigate('Menu'));
  await act(async () => nav.navigate('Menu', { screen: 'VendorItemEditor' }));
  expect(menuStack()).toEqual(['VendorMenu', 'VendorItemEditor']);
  await act(async () => nav.navigate('Home'));
  expect(tab()).toBe('Home');
}
async function tap(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => { button!.click(); });
}

describe('[UI-SWEEP U29] the board\'s menu doors go back to the Menu tab\'s own list', () => {
  it('with an item editor left open, "Menu & inventory" shows ONE menu list and no stale editor', async () => {
    await mount();
    await leaveAnEditorOpen();
    await tap('Menu & inventory');
    expect(tab()).toBe('Menu');
    expect(menuStack()).toEqual(['VendorMenu']);
  });

  it('repeated board -> menu loops never grow the Menu stack', async () => {
    await mount();
    for (let i = 0; i < 3; i++) {
      await leaveAnEditorOpen();
      await tap('Menu & inventory');
      expect(menuStack()).toEqual(['VendorMenu']);
    }
  });

  it('control: the plain navigate main shipped stacks a second list over the stale editor', async () => {
    await mount();
    await leaveAnEditorOpen();
    await tap('plain navigate');
    expect(menuStack()).toEqual(['VendorMenu', 'VendorItemEditor', 'VendorMenu']);
  });

  it('every board door in VendorOps goes through openMenuList (no raw navigate to the Menu tab)', () => {
    const ops = readFileSync(join(__dirname, 'screens/VendorOps.tsx'), 'utf8');
    expect(ops).not.toMatch(/navigate\(\s*['"]Menu['"]/);
    expect((ops.match(/openMenuList\(navigation\)/g) ?? []).length).toBe(5);
  });
});
