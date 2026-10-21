/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// ---------------------------------------------------------------------------
// [UI-SWEEP U35] Account -> Change vehicle -> (vehicle changed) -> Documents.
// The documents screen REPLACES the finished vehicle form, so Back goes to
// Account and never to a form whose change is already made. The REAL
// MoverVehicleScreen on a real stack; the vehicle picker is a stand-in that
// reports "changed" the way VehicleSetup's onDone does.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  onDone: null as null | ((changed: boolean) => void),
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
vi.mock('@swift/ui', () => ({ color: fx.token, space: fx.token }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  return { Screen: (p: any) => R.createElement('div', null, p.children), Header: (p: any) => R.createElement('header', null, p.title) };
});
vi.mock('../../../kit/toast', () => ({ toast: { show: vi.fn(), success: vi.fn() } }));
vi.mock('../../../hooks', () => ({ useMoverKind: () => ({ profile: { vehicleType: 'MOTORCYCLE' } }) }));
vi.mock('../../../hooks/useStepUp', () => ({ useStepUp: () => ({ withStepUp: (fn: unknown) => fn, sheet: null }) }));
vi.mock('../shared', () => ({ GUTTER: 16 }));
vi.mock('./MoverOnboardingScreen', () => ({
  VehicleSetup: (p: { onDone: (changed: boolean) => void }) => { fx.onDone = p.onDone; return null; },
}));

import { MoverVehicleScreen } from './MoverVehicleScreen';

const nav = createNavigationContainerRef<Record<string, object | undefined>>();
const Stack = createNativeStackNavigator();
const h = React.createElement;
const Account = () => h('p', null, 'account');
const Documents = () => h('p', null, 'documents');

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  fx.onDone = null;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(h(NavigationContainer as any, { ref: nav, linking: { enabled: false, prefixes: [] } },
    h(Stack.Navigator, {
      screenOptions: { headerShown: false },
      children: [
        h(Stack.Screen, { key: 'MoverAccount', name: 'MoverAccount', component: Account }),
        h(Stack.Screen, { key: 'MoverVehicle', name: 'MoverVehicle', component: MoverVehicleScreen }),
        h(Stack.Screen, { key: 'MoverDocuments', name: 'MoverDocuments', component: Documents }),
      ],
    }))));
  await act(async () => nav.navigate('MoverVehicle'));
  expect(fx.onDone, 'the vehicle form is on screen').toBeTypeOf('function');
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const stack = () => nav.getRootState().routes.map((r) => r.name);

describe('[UI-SWEEP U35] a changed vehicle opens Documents IN PLACE of the vehicle form', () => {
  it('changed: the stack is Account, Documents; Back returns to Account', async () => {
    await act(async () => fx.onDone!(true));
    expect(stack()).toEqual(['MoverAccount', 'MoverDocuments']);
    await act(async () => nav.goBack());
    expect(stack()).toEqual(['MoverAccount']);
  });

  it('no change: the form stays and nothing moves', async () => {
    await act(async () => fx.onDone!(false));
    expect(stack()).toEqual(['MoverAccount', 'MoverVehicle']);
  });
});
