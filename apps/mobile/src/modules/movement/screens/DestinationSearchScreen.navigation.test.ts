/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef, useNavigation } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// ---------------------------------------------------------------------------
// [UI-SWEEP U68 U69 U70] "Where to?" — the place search behind Taxi and
// Send a parcel. A second tap on a suggestion while the first was still
// opening chose the place twice and went back TWICE, closing the Taxi screen
// too (U68). A place that could not be opened did nothing and said nothing
// (U69). A search that failed said "No matches", blaming the place, and the
// same words flashed before a search had even run (U70). The REAL
// DestinationSearchScreen in a real NavigationContainer + native-stack; only
// native drawing, the kit and the place lookups are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  onSelect: vi.fn(),
  details: vi.fn(),
  refetch: vi.fn(),
  auto: { data: undefined as unknown, isFetching: false, isError: false },
  saved: [] as any[],
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const View = ({ children }: any) => h('div', null, typeof children === 'function' ? children({ pressed: false }) : children);
  const Pressable = ({ children, onPress, disabled }: any) =>
    h('button', { type: 'button', disabled: !!disabled, onClick: disabled ? undefined : onPress }, typeof children === 'function' ? children({ pressed: false }) : children);
  const FlatList = ({ data, renderItem, keyExtractor, ListEmptyComponent, ListHeaderComponent }: any) =>
    h('div', null, ListHeaderComponent ?? null,
      (data ?? []).length === 0 ? (ListEmptyComponent ?? null)
        : (data as any[]).map((item) => h(R.Fragment, { key: keyExtractor(item) }, renderItem({ item }))));
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, Image: View, Pressable, FlatList,
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

vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, space: fx.token }));
vi.mock('../../../hooks', () => ({ useAddresses: () => ({ data: fx.saved }) }));
vi.mock('../../../hooks/usePlacesAutocomplete', () => ({
  usePlacesAutocomplete: () => ({ ...fx.auto, refetch: fx.refetch }),
  usePlaceDetails: () => fx.details,
}));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: 6.81, longitude: -58.16 }) }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = ({ children }: any) => h('div', null, children);
  return {
    Card: Box, Screen: Box, IconChip: () => null, Header: ({ title }: any) => h('header', null, title),
    T: ({ children }: any) => h('span', null, children),
    LabeledInput: (p: any) => h('div', null,
      h('input', { 'aria-label': p.placeholder, value: p.value, onChange: (e: any) => p.onChangeText(e.target.value) }), p.right ?? null),
    EmptyState: (p: any) => h('section', null, h('h3', null, p.title), p.body ? h('p', null, p.body) : null,
      p.actionLabel ? h('button', { type: 'button', onClick: p.onAction }, p.actionLabel) : null),
  };
});

import { DestinationSearchScreen } from './DestinationSearchScreen';

const nav = createNavigationContainerRef<Record<string, object | undefined>>();
const Stack = createNativeStackNavigator();
const h = React.createElement;
function Taxi() {
  const navigation = useNavigation<any>();
  return h('button', { type: 'button', onClick: () => navigation.navigate('DestinationSearch', { onSelect: fx.onSelect, title: 'Where to?' }) }, 'Where to?');
}
const LAMAHA = { placeId: 'place-lamaha', primary: 'Lamaha Street', secondary: 'Georgetown' };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  fx.details.mockReset();
  fx.saved = [];
  fx.auto = { data: [LAMAHA], isFetching: false, isError: false };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const stack = () => nav.getRootState().routes.map((r) => r.name);
const text = () => host.textContent ?? '';
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').startsWith(label));
async function tap(label: string) {
  const el = button(label);
  expect(el, label).toBeTruthy();
  await act(async () => { el!.click(); });
}
function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function openSearch(typed = 'Lam') {
  await act(async () => root.render(h(NavigationContainer as any, { ref: nav, linking: { enabled: false, prefixes: [] } },
    h(Stack.Navigator, {
      screenOptions: { headerShown: false },
      children: [
        h(Stack.Screen, { key: 'Taxi', name: 'Taxi', component: Taxi }),
        h(Stack.Screen, { key: 'DestinationSearch', name: 'DestinationSearch', component: DestinationSearchScreen }),
      ],
    }))));
  await tap('Where to?');
  await settle();
  expect(stack()).toEqual(['Taxi', 'DestinationSearch']);
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search a place or address"]')!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
  await act(async () => { setter.call(input, typed); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
}

describe('[UI-SWEEP U68] a suggestion is chosen once', () => {
  it('a second tap while the first is still opening never chooses twice or closes the Taxi screen', async () => {
    const pending = deferred<unknown>();
    fx.details.mockReturnValue(pending.promise);
    await openSearch();
    await tap('Lamaha Street');
    await tap('Lamaha Street');
    await act(async () => { pending.resolve({ lat: 6.82, lng: -58.15, label: 'Lamaha Street', placeId: 'place-lamaha' }); });
    await settle();
    expect(fx.details).toHaveBeenCalledTimes(1);
    expect(fx.onSelect).toHaveBeenCalledTimes(1);
    expect(stack(), 'one step back: the Taxi screen stays').toEqual(['Taxi']);
  });
});

describe('[UI-SWEEP U68] a saved place is chosen once', () => {
  it('a double tap on a saved place chooses it once and goes back one step', async () => {
    fx.saved = [{ id: 'home', label: 'Home', addressLine1: 'Lot 1 Main Street', city: 'Georgetown', latitude: 6.8, longitude: -58.16 }];
    await openSearch('');
    const row = button('Home')!;
    await act(async () => { row.click(); row.click(); });
    await settle();
    expect(fx.onSelect).toHaveBeenCalledTimes(1);
    expect(stack()).toEqual(['Taxi']);
  });
});

describe('[UI-SWEEP U69] a place that cannot be opened says so', () => {
  it('a failed lookup explains itself, keeps the search open, and the next tap works', async () => {
    fx.details.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ lat: 6.82, lng: -58.15, label: 'Lamaha Street' });
    await openSearch();
    await tap('Lamaha Street');
    await settle();
    expect(text()).toContain('That place could not be opened.');
    expect(stack()).toEqual(['Taxi', 'DestinationSearch']);
    expect(fx.onSelect).not.toHaveBeenCalled();
    await tap('Lamaha Street');
    await settle();
    expect(fx.onSelect).toHaveBeenCalledTimes(1);
    expect(stack()).toEqual(['Taxi']);
  });

  it('a place the lookup cannot resolve explains itself too', async () => {
    fx.details.mockResolvedValue(null);
    await openSearch();
    await tap('Lamaha Street');
    await settle();
    expect(text()).toContain('That place could not be opened.');
    expect(stack()).toEqual(['Taxi', 'DestinationSearch']);
  });
});

describe('[UI-SWEEP U70] "No matches" means the search ran and found nothing', () => {
  it('a failed search says the search failed, with a Try again, never "No matches"', async () => {
    fx.auto = { data: undefined, isFetching: false, isError: true };
    await openSearch();
    expect(text()).not.toContain('No matches');
    expect(text()).toContain('Search is not working right now');
    await tap('Try again');
    expect(fx.refetch).toHaveBeenCalledTimes(1);
  });

  it('before the search has answered, nothing claims "No matches"', async () => {
    fx.auto = { data: undefined, isFetching: false, isError: false };
    await openSearch();
    expect(text()).not.toContain('No matches');
  });

  it('a search that answered with nothing still says "No matches"', async () => {
    fx.auto = { data: [], isFetching: false, isError: false };
    await openSearch();
    expect(text()).toContain('No matches');
  });
});
